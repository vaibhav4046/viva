Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot '..\..\fixtures\audio'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$lines = @{
  'student-correct' = 'Positional encoding adds information about token order before the first self-attention layer.'
  'student-misconception' = 'Examine me on multi-head attention. I think it runs a single head over the input.'
  'student-interruption' = 'Wait, can you repeat the question?'
}
foreach ($name in $lines.Keys) {
  $wav = Join-Path $out "$name.wav"
  $spoken = $lines[$name]
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SetOutputToWaveFile($wav)
  $s.Speak($spoken)
  $s.Dispose()
  Set-Content -LiteralPath (Join-Path $out "$name.txt") -Value "Synthetic speech, generated with Windows System.Speech. Spoken text: $spoken" -Encoding UTF8
  Write-Output "$name.wav generated (synthetic learner voice)"
}
