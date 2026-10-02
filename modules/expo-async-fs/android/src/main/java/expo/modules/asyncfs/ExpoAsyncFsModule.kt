package expo.modules.asyncfs

import android.net.Uri
import android.os.Bundle
import androidx.core.os.bundleOf
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.Source
import okio.buffer
import java.io.File
import java.io.IOException
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap

class ExpoAsyncFsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoAsyncFs")

    Events("onDownloadProgress")

    // `File.list()` returns null both for "not a directory" and for an I/O
    // error, so a missing path and an UNREADABLE one are indistinguishable
    // downstream. Callers that walk a cache and delete rows for whatever they
    // don't see must be able to tell those apart, so an existing-but-unreadable
    // path throws here (matching iOS) while a missing path keeps returning an
    // empty list — the many callers that list a maybe-absent directory rely on
    // that.
    AsyncFunction("listDirectoryAsync") { uri: String ->
      val path = Uri.parse(uri).path ?: return@AsyncFunction emptyList<String>()
      val file = File(path)
      val names = file.list()
      if (names == null) {
        if (file.exists()) throw IOException("Cannot list directory: $path")
        return@AsyncFunction emptyList<String>()
      }
      names.toList()
    }

    AsyncFunction("getDirectorySizeAsync") { uri: String ->
      val path = Uri.parse(uri).path ?: return@AsyncFunction 0L
      directorySize(File(path))
    }

    // One off-thread call that returns each entry's name + size + type, so
    // callers don't have to do a sync File.exists/File.size stat per child on
    // the JS thread (expo-file-system's .exists/.size are sync-only). Used by
    // reconcileImageCache to walk the cover-art cache without blocking JS.
    AsyncFunction("listDirectoryWithSizesAsync") { uri: String ->
      val path = Uri.parse(uri).path ?: return@AsyncFunction emptyList<Bundle>()
      val dir = File(path)
      // Same existing-but-unreadable vs missing distinction as listDirectoryAsync.
      val entries = dir.listFiles()
        ?: if (dir.exists()) throw IOException("Cannot list directory: $path")
           else return@AsyncFunction emptyList<Bundle>()
      entries.map { f ->
        bundleOf(
          "name" to f.name,
          "size" to (if (f.isFile) f.length().toDouble() else 0.0),
          "isDirectory" to f.isDirectory,
        )
      }
    }

    // Off-thread existence + size + type stat. Single call so a render-path
    // consumer can confirm a file without a sync File.exists/File.length on the
    // JS thread (expo-file-system's are sync-only). `size` is 0 for missing
    // entries and directories.
    AsyncFunction("statAsync") { uri: String ->
      val path = Uri.parse(uri).path
        ?: return@AsyncFunction bundleOf("exists" to false, "size" to 0.0, "isDirectory" to false)
      val f = File(path)
      val exists = f.exists()
      bundleOf(
        "exists" to exists,
        "size" to (if (exists && f.isFile) f.length().toDouble() else 0.0),
        "isDirectory" to (exists && f.isDirectory),
      )
    }

    // Off-thread file delete. Returns true if a file existed and was deleted.
    AsyncFunction("deleteFileAsync") { uri: String ->
      val path = Uri.parse(uri).path ?: return@AsyncFunction false
      val f = File(path)
      if (f.exists()) f.delete() else false
    }

    // Off-thread RECURSIVE directory delete (the whole cache wipe on logout /
    // clear-cache). expo-file-system's Directory.delete is sync-only and would
    // unlink potentially thousands of files on the JS thread. Dispatched to
    // Dispatchers.IO so a large wipe runs in parallel off the module queue.
    AsyncFunction("deleteDirectoryAsync") { uri: String, promise: Promise ->
      CoroutineScope(Dispatchers.IO).launch {
        try {
          val path = Uri.parse(uri).path
          if (path == null) {
            promise.resolve(false)
            return@launch
          }
          val dir = File(path)
          promise.resolve(if (dir.exists()) dir.deleteRecursively() else false)
        } catch (e: Exception) {
          promise.reject("ERR_DELETE_DIR", e.message ?: "Recursive delete failed", e)
        }
      }
    }

    // Mirrors expo-file-system's downloadFileAsync but adds a network
    // interceptor for progress events. Uses OkHttpClientProvider (rather
    // than a bare OkHttpClient) so the RN network stack configuration
    // (including custom SSL trust) is inherited.
    //
    // Takes a Promise parameter and dispatches to Dispatchers.IO so that
    // concurrent calls run on separate threads. Expo's default module
    // queue is a single HandlerThread; without this, blocking execute()
    // calls would serialize all downloads.
    AsyncFunction("downloadFileAsyncWithProgress") { url: String, destinationUri: String, downloadId: String, promise: Promise ->
      download(url, destinationUri, downloadId, validateAudio = false, promise)
    }

    // Audio variant: never rejects for an HTTP-level failure. Non-2xx and
    // non-audio bodies (a Subsonic XML/JSON error returned with HTTP 200)
    // resolve with `rejected` set and nothing left at the destination.
    AsyncFunction("downloadAudioFileAsync") { url: String, destinationUri: String, downloadId: String, promise: Promise ->
      download(url, destinationUri, downloadId, validateAudio = true, promise)
    }

    AsyncFunction("cancelDownloadAsync") { downloadId: String ->
      val call = activeCalls.remove(downloadId)
      call?.cancel()
      call != null
    }
  }

  private val activeCalls = ConcurrentHashMap<String, Call>()

  // Mirrors expo-file-system's downloadFileAsync but adds a network
  // interceptor for progress events. Uses OkHttpClientProvider (rather
  // than a bare OkHttpClient) so the RN network stack configuration
  // (including custom SSL trust) is inherited.
  //
  // Dispatches to Dispatchers.IO so that concurrent calls run on separate
  // threads. Expo's default module queue is a single HandlerThread; without
  // this, blocking execute() calls would serialize all downloads.
  private fun download(
    url: String,
    destinationUri: String,
    downloadId: String,
    validateAudio: Boolean,
    promise: Promise,
  ) {
    CoroutineScope(Dispatchers.IO).launch {
      var call: Call? = null
      try {
        val destPath = Uri.parse(destinationUri).path
          ?: throw Exception("Invalid destination URI")
        val destFile = File(destPath)
        destFile.parentFile?.mkdirs()

        var lastEventTime = 0L

        val client = OkHttpClientProvider.createClient().newBuilder()
          .addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            val body = response.body ?: return@addNetworkInterceptor response
            val contentLength = body.contentLength()
            val source = object : ForwardingSource(body.source()) {
              var totalBytesRead = 0L

              override fun read(sink: Buffer, byteCount: Long): Long {
                val bytesRead = super.read(sink, byteCount)
                if (bytesRead != -1L) totalBytesRead += bytesRead
                val now = System.currentTimeMillis()
                val isComplete = contentLength > 0 && totalBytesRead >= contentLength
                if (now - lastEventTime >= 100 || isComplete) {
                  lastEventTime = now
                  sendEvent("onDownloadProgress", bundleOf(
                    "downloadId" to downloadId,
                    "bytesWritten" to totalBytesRead.toDouble(),
                    "totalBytes" to contentLength.toDouble(),
                  ))
                }
                return bytesRead
              }
            }
            response.newBuilder()
              .body(ProgressResponseBody(body.contentType(), contentLength, source.buffer()))
              .build()
          }
          .build()

        val request = Request.Builder().url(url).build()
        call = client.newCall(request)
        activeCalls[downloadId] = call
        val response = call.execute()

        if (!response.isSuccessful) {
          val code = response.code
          val retryAfter = response.header("Retry-After")?.trim()?.toIntOrNull()
          response.close()
          if (!validateAudio) throw Exception("Download failed with HTTP status $code")
          promise.resolve(rejection("http", code, retryAfter, destFile))
          return@launch
        }

        val body = response.body ?: throw Exception("Empty response body")
        // Completion is judged by HTTP status + a clean read to EOF, NOT by
        // matching bytes-written against Content-Length. Subsonic estimates
        // Content-Length for on-the-fly transcodes, so the real byte count
        // legitimately differs from the header — a length check would reject
        // good downloads. A genuinely incomplete transfer surfaces as a
        // non-success status (handled above) or a stream read error thrown
        // out of copyTo below; reaching the end cleanly on a 2xx response is
        // authoritative completion.
        body.byteStream().use { input ->
          FileOutputStream(destFile).use { output ->
            input.copyTo(output)
          }
        }

        if (validateAudio && looksLikeTextBody(destFile)) {
          destFile.delete()
          promise.resolve(rejection("notAudio", response.code, null, destFile))
          return@launch
        }

        val fileSize = destFile.length()
        promise.resolve(bundleOf(
          "uri" to Uri.fromFile(destFile).toString(),
          "bytes" to fileSize.toDouble(),
          "status" to response.code,
        ))
      } catch (e: Exception) {
        promise.reject("ERR_DOWNLOAD", e.message ?: "Download failed", e)
      } finally {
        // Only our own call: a retry of the same id may already have registered.
        call?.let { activeCalls.remove(downloadId, it) }
      }
    }
  }

  private fun rejection(reason: String, status: Int, retryAfter: Int?, destFile: File): Bundle {
    val result = bundleOf(
      "uri" to Uri.fromFile(destFile).toString(),
      "bytes" to 0.0,
      "status" to status,
      "rejected" to reason,
    )
    if (retryAfter != null) result.putInt("retryAfterSeconds", retryAfter)
    return result
  }

  // A Subsonic error body (XML or JSON) starts with `<` or `{` after optional
  // whitespace / UTF-8 BOM. No audio container starts with either byte.
  private fun looksLikeTextBody(file: File): Boolean {
    val head = ByteArray(64)
    val read = file.inputStream().use { it.read(head) }
    if (read <= 0) return true
    for (i in 0 until read) {
      when (head[i].toInt() and 0xFF) {
        0x20, 0x09, 0x0A, 0x0D, 0xEF, 0xBB, 0xBF -> continue
        0x3C, 0x7B -> return true
        else -> return false
      }
    }
    return true
  }

  private fun directorySize(dir: File): Long {
    if (!dir.exists()) return 0
    return dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
  }
}

private class ProgressResponseBody(
  private val contentType: MediaType?,
  private val contentLength: Long,
  private val bufferedSource: BufferedSource,
) : ResponseBody() {
  override fun contentType(): MediaType? = contentType
  override fun contentLength(): Long = contentLength
  override fun source(): BufferedSource = bufferedSource
}
