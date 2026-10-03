require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoContinuedProcessing'
  s.version        = package['version']
  s.summary        = 'BGContinuedProcessingTask bridge for user-started downloads'
  s.description    = 'Keeps a user-started download queue running in the background on iOS 26+'
  s.author         = 'Gaven Henry'
  s.homepage       = 'https://github.com/substreamer'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/substreamer/substreamer-rn.git', tag: s.version.to_s }
  s.static_framework = true
  s.license        = { :type => 'MIT' }

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'BackgroundTasks'

  s.source_files = '**/*.swift'
end
