Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot "..\apps\web\public\icons"
New-Item -ItemType Directory -Path $iconDir -Force | Out-Null

function New-RoundRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-ScheduleIcon {
  param(
    [int]$Size,
    [string]$Path
  )

  $scale = $Size / 512.0
  function S([float]$value) {
    return [float]($value * $scale)
  }

  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#A65035"))

  $paper = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#FFFAF1"))
  $accentSoft = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#F0C9B6"))
  $done = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#5D7F68"))
  $outlineColor = [System.Drawing.Color]::FromArgb(42, [System.Drawing.ColorTranslator]::FromHtml("#312C24"))
  $outline = New-Object System.Drawing.Pen($outlineColor, (S 10))
  $accent = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml("#A65035"), (S 12))
  $ink = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml("#312C24"), (S 18))
  $muted = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml("#837869"), (S 14))

  foreach ($pen in @($accent, $ink, $muted)) {
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  }

  $paperPath = New-RoundRectanglePath (S 92) (S 74) (S 328) (S 364) (S 54)
  $graphics.FillPath($paper, $paperPath)
  $graphics.DrawPath($outline, $paperPath)

  $topPath = New-RoundRectanglePath (S 132) (S 124) (S 248) (S 52) (S 18)
  $graphics.FillPath($accentSoft, $topPath)

  $graphics.DrawEllipse($accent, (S 136), (S 208), (S 36), (S 36))
  $graphics.DrawLine($ink, (S 204), (S 219), (S 336), (S 219))
  $graphics.DrawLine($muted, (S 204), (S 249), (S 294), (S 249))

  $graphics.FillEllipse($done, (S 133), (S 297), (S 42), (S 42))
  $graphics.DrawLine($ink, (S 204), (S 310), (S 346), (S 310))
  $graphics.DrawLine($muted, (S 204), (S 341), (S 320), (S 341))

  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

  foreach ($item in @($paperPath, $topPath, $paper, $accentSoft, $done, $outline, $accent, $ink, $muted, $graphics, $bitmap)) {
    $item.Dispose()
  }
}

New-ScheduleIcon 180 (Join-Path $iconDir "apple-touch-icon.png")
New-ScheduleIcon 192 (Join-Path $iconDir "icon-192.png")
New-ScheduleIcon 512 (Join-Path $iconDir "icon-512.png")

Get-ChildItem $iconDir | Select-Object Name,Length

