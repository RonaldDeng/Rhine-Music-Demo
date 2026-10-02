# Builds windows/app.ico (16/32/48/64/128/256 px PNG frames) from public/icons/icon-512.png.
param([string]$Source = "$PSScriptRoot\..\public\icons\icon-512.png", [string]$Target = "$PSScriptRoot\app.ico")
Add-Type -AssemblyName System.Drawing
$sizes = 16, 32, 48, 64, 128, 256
$original = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
$frames = foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($original, 0, 0, $size, $size)
  $graphics.Dispose()
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
}
$original.Dispose()
$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $out
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($frame in $frames) {
  $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
  $offset += $frame.Bytes.Length
}
foreach ($frame in $frames) { $writer.Write($frame.Bytes) }
$writer.Flush()
[System.IO.File]::WriteAllBytes($Target, $out.ToArray())
Write-Host "wrote $Target ($($out.Length) bytes)"
