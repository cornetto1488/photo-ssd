# ZALET HOME: рисует иконки (.ico) и курсоры (.cur) в стиле сайта — чёрный, тонкий оранжевый акцент, без градиентов.
# Результат: icons\*.ico, cursors\*.cur и preview.png рядом со скриптом.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$icoDir = Join-Path $root 'icons'; $curDir = Join-Path $root 'cursors'
New-Item -ItemType Directory -Force -Path $icoDir, $curDir | Out-Null

$OR = [Drawing.Color]::FromArgb(255, 255, 90, 31)
$OR2 = [Drawing.Color]::FromArgb(255, 255, 138, 76)
$INK = [Drawing.Color]::FromArgb(255, 246, 243, 238)
$K0 = [Drawing.Color]::FromArgb(255, 9, 9, 12)
$K1 = [Drawing.Color]::FromArgb(255, 18, 18, 23)
$K2 = [Drawing.Color]::FromArgb(255, 30, 30, 37)
$K3 = [Drawing.Color]::FromArgb(255, 44, 44, 53)
$EDGE = [Drawing.Color]::FromArgb(255, 58, 58, 68)

function RR([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90); $p.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
  $p.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90); $p.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
  $p.CloseFigure(); return $p
}
function Poly([float[]]$xy) { $p = New-Object Drawing.Drawing2D.GraphicsPath; $pts = @(); for ($i = 0; $i -lt $xy.Count; $i += 2) { $pts += New-Object Drawing.PointF($xy[$i], $xy[$i+1]) }; $p.AddPolygon([Drawing.PointF[]]$pts); return $p }
function Pen($c, [float]$w) { $p = New-Object Drawing.Pen $c, $w; $p.StartCap = 'Round'; $p.EndCap = 'Round'; $p.LineJoin = 'Round'; return $p }
function Brush($c) { New-Object Drawing.SolidBrush $c }
function Canvas([int]$s) { $b = New-Object Drawing.Bitmap $s, $s, ([Drawing.Imaging.PixelFormat]::Format32bppArgb); $g = [Drawing.Graphics]::FromImage($b); $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'; $g.Clear([Drawing.Color]::Transparent); return @($b, $g) }
function Scale($src, [int]$s) { $r = New-Object Drawing.Bitmap $s, $s, ([Drawing.Imaging.PixelFormat]::Format32bppArgb); $g = [Drawing.Graphics]::FromImage($r); $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.SmoothingMode = 'HighQuality'; $g.DrawImage($src, 0, 0, $s, $s); $g.Dispose(); return $r }
function PngBytes($bmp) { $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $a = $ms.ToArray(); $ms.Dispose(); return ,$a }
# 32-битный DIB (для .cur и мелких размеров .ico)
function DibBytes($bmp) {
  $w = $bmp.Width; $h = $bmp.Height; $ms = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter $ms
  $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2)); $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0); $bw.Write([uint32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
  for ($y = $h - 1; $y -ge 0; $y--) { for ($x = 0; $x -lt $w; $x++) { $c = $bmp.GetPixel($x, $y); $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A) } }
  $maskRow = [int]([Math]::Ceiling($w / 32.0) * 4); $zero = New-Object byte[] ($maskRow * $h); $bw.Write($zero)
  $bw.Flush(); $a = $ms.ToArray(); $bw.Dispose(); return ,$a
}
function WriteIcoCur([string]$path, $master, [int[]]$sizes, [int]$type, [float]$hx, [float]$hy) {
  $imgs = @(); foreach ($s in $sizes) { $sm = Scale $master $s; if ($s -ge 256) { $imgs += ,(PngBytes $sm) } else { $imgs += ,(DibBytes $sm) }; $sm.Dispose() }
  $fs = [IO.File]::Create($path); $bw = New-Object IO.BinaryWriter $fs
  $bw.Write([uint16]0); $bw.Write([uint16]$type); $bw.Write([uint16]$sizes.Count)
  $off = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $wh = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$wh); $bw.Write([byte]$wh); $bw.Write([byte]0); $bw.Write([byte]0)
    if ($type -eq 2) { $bw.Write([uint16][Math]::Round($hx * $s)); $bw.Write([uint16][Math]::Round($hy * $s)) } else { $bw.Write([uint16]1); $bw.Write([uint16]32) }
    $bw.Write([uint32]$imgs[$i].Length); $bw.Write([uint32]$off); $off += $imgs[$i].Length
  }
  foreach ($im in $imgs) { $bw.Write($im) }
  $bw.Close(); $fs.Close()
}

# ---------- иконки: рисуем на 1024, сохраняем 256/64/48/32/24/16 ----------
$S = 1024
$icons = [ordered]@{}
function Icon([string]$name, [scriptblock]$paint) { $b, $g = Canvas $S; & $paint $g; $g.Dispose(); $script:icons[$name] = $b }
# Минималистичные линейные иконки: тонкий оранжевый контур без подложки, как значки на сайте.
$LW = 46   # толщина линии на холсте 1024 (≈ 2 px при размере значка 48)
function Ln($g) { Pen $OR $LW }
function Pts([float[]]$xy) { $a = @(); for ($i = 0; $i -lt $xy.Count; $i += 2) { $a += New-Object Drawing.PointF($xy[$i], $xy[$i+1]) }; return [Drawing.PointF[]]$a }
# контур папки: вкладка + корпус одной линией
function FolderPath {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $p.AddLines((Pts @(150, 300, 150, 250, 190, 210, 400, 210, 460, 280, 834, 280, 874, 320, 874, 790, 834, 830, 190, 830, 150, 790, 150, 300)))
  $p.CloseFigure(); return $p
}
function Folder($g, [scriptblock]$glyph) {
  $g.DrawPath((Ln $g), (FolderPath))
  $g.DrawLine((Ln $g), 150, 380, 874, 380)
  if ($glyph) { $s = $g.Save(); $g.TranslateTransform(512, 600); & $glyph $g; $g.Restore($s) }
}
$GP = { Pen $OR 38 }
Icon 'folder' { param($g) Folder $g $null }
# Крупные отдельные значки для папок пользователя — без рамки папки, чтобы читались и в маленьком размере
Icon 'folder-docs' { param($g) $p = Ln $g; $pg = New-Object Drawing.Drawing2D.GraphicsPath; $pg.AddLines((Pts @(290, 160, 610, 160, 754, 304, 754, 864, 290, 864))); $pg.CloseFigure(); $g.DrawPath($p, $pg); $g.DrawLines($p, (Pts @(610, 160, 610, 304, 754, 304))); $g.DrawLine($p, 390, 480, 654, 480); $g.DrawLine($p, 390, 590, 654, 590); $g.DrawLine($p, 390, 700, 560, 700) }
Icon 'folder-downloads' { param($g) $p = Ln $g; $g.DrawLine($p, 512, 160, 512, 640); $g.DrawLines($p, (Pts @(320, 450, 512, 640, 704, 450))); $g.DrawLines($p, (Pts @(200, 690, 200, 850, 824, 850, 824, 690))) }
Icon 'folder-pictures' { param($g) $p = Ln $g; $f = RR 160 220 704 584 70; $g.DrawPath($p, $f); $g.DrawEllipse($p, 600, 320, 120, 120); $g.DrawLines($p, (Pts @(170, 720, 410, 480, 570, 640, 660, 550, 854, 744))) }
Icon 'gallery' { param($g) $p = Ln $g; $b = RR 290 160 574 470 60; $g.DrawPath($p, $b); $f = RR 160 330 574 500 60; $g.FillPath((Brush $K0), $f); $g.DrawPath($p, $f); $g.DrawLines($p, (Pts @(170, 760, 360, 570, 500, 710, 580, 630, 724, 774))); $g.DrawEllipse($p, 560, 420, 90, 90) }
Icon 'folder-music' { param($g) $p = Ln $g; $g.DrawLine($p, 400, 300, 400, 720); $g.DrawLine($p, 780, 230, 780, 650); $beam = New-Object Drawing.Drawing2D.GraphicsPath; $beam.AddPolygon((Pts @(400, 300, 780, 230, 780, 330, 400, 400))); $g.FillPath((Brush $OR), $beam); $g.FillEllipse((Brush $OR), 230, 640, 190, 150); $g.FillEllipse((Brush $OR), 610, 570, 190, 150) }
Icon 'folder-videos' { param($g) $p = Ln $g; $r = RR 140 240 744 544 90; $g.DrawPath($p, $r); $t = New-Object Drawing.Drawing2D.GraphicsPath; $t.AddPolygon((Pts @(430, 370, 660, 512, 430, 654))); $g.FillPath((Brush $OR), $t) }
Icon 'folder-desktop' { param($g) $p = Ln $g; $m = RR 140 200 744 480 50; $g.DrawPath($p, $m); $g.DrawLine($p, 512, 680, 512, 810); $g.DrawLine($p, 340, 830, 684, 830) }
Icon 'folder-zalet' { param($g) Folder $g { param($g) $p = & $GP; $g.DrawLines($p, (Pts @(-120, 0, 0, -105, 120, 0))); $g.DrawLines($p, (Pts @(-85, -30, -85, 120, 85, 120, 85, -30))) } }

function Bin($g, [bool]$full) {
  $p = Ln $g
  $g.DrawLine($p, 230, 300, 794, 300)
  $g.DrawLines($p, (Pts @(410, 300, 430, 220, 594, 220, 614, 300)))
  $body = New-Object Drawing.Drawing2D.GraphicsPath; $body.AddLines((Pts @(290, 300, 340, 850, 684, 850, 734, 300)))
  $g.DrawPath($p, $body)
  foreach ($x in 440, 512, 584) { $g.DrawLine($p, $x, 420, $x + ($x - 512) * 0.1, 730) }
  if ($full) { $f = New-Object Drawing.Drawing2D.GraphicsPath; $f.AddPolygon((Pts @(300, 255, 380, 150, 470, 210, 560, 120, 660, 200, 724, 255))); $g.FillPath((Brush $OR), $f) }
}
Icon 'recycle-empty' { param($g) Bin $g $false }
Icon 'recycle-full' { param($g) Bin $g $true }
Icon 'pc' { param($g) $p = Ln $g; $m = RR 170 210 684 450 40; $g.DrawPath($p, $m); $g.DrawLine($p, 512, 660, 512, 790); $g.DrawLine($p, 360, 810, 664, 810) }
Icon 'drive' { param($g) $p = Ln $g; $d = RR 150 360 724 304 70; $g.DrawPath($p, $d); $g.DrawLine($p, 260, 512, 520, 512); $g.FillEllipse((Brush $OR), 690, 478, 70, 70) }
Icon 'network' { param($g) $p = Ln $g; $g.DrawEllipse($p, 210, 210, 604, 604); $g.DrawEllipse($p, 390, 210, 244, 604); $g.DrawLine($p, 210, 512, 814, 512) }
Icon 'user' { param($g) $p = Ln $g; $g.DrawEllipse($p, 377, 190, 270, 270); $g.DrawArc($p, 230, 530, 564, 520, 200, 140) }
Icon 'zalet' { param($g) $p = Ln $g; $g.DrawLines($p, (Pts @(170, 500, 512, 200, 854, 500))); $g.DrawLines($p, (Pts @(260, 420, 260, 840, 764, 840, 764, 420))); $g.DrawLines($p, (Pts @(440, 840, 440, 640, 584, 640, 584, 840))) }

Icon 'usb' { param($g) $p = Ln $g; $c = RR 412 150 200 200 26; $g.DrawPath($p, $c); $g.DrawLine($p, 470, 230, 470, 270); $g.DrawLine($p, 554, 230, 554, 270); $b = RR 340 350 344 520 70; $g.DrawPath($p, $b); $g.FillEllipse((Brush $OR), 477, 720, 70, 70) }
Icon 'drive-net' { param($g) $p = Ln $g; $d = RR 150 200 724 290 70; $g.DrawPath($p, $d); $g.DrawLine($p, 260, 345, 520, 345); $g.FillEllipse((Brush $OR), 690, 310, 70, 70); $g.DrawLine($p, 512, 490, 512, 720); $g.DrawLine($p, 230, 790, 794, 790); $g.FillEllipse((Brush $OR), 462, 740, 100, 100) }

foreach ($n in $icons.Keys) { WriteIcoCur (Join-Path $icoDir "$n.ico") $icons[$n] @(256, 64, 48, 32, 24, 16) 1 0 0 }

# ---------- курсоры: рисуем на 256 (= 32 px * 8), сохраняем 32/48/64/96/128 ----------
$C = 256; $u = 8.0
$K = 0.74   # итоговый размер: стрелка ~19 px из 32, как у стандартного курсора Windows
function Prep($g, [float]$hx, [float]$hy) { $g.TranslateTransform($hx * $C, $hy * $C); $g.ScaleTransform($K, $K); $g.TranslateTransform(-$hx * $C, -$hy * $C) }
$cursors = [ordered]@{}
# всё, что рисуется: сначала толстый оранжевый контур всех фигур, потом заливка — получается единая аккуратная обводка
function Cursor([string]$name, [float]$hx, [float]$hy, [scriptblock]$shapes, [string]$fill = 'black') {
  $b, $g = Canvas $C; Prep $g $hx $hy
  $paths = & $shapes
  $outline = New-Object Drawing.Pen $OR, (1.9 * $u); $outline.LineJoin = 'Round'
  foreach ($p in $paths) { $g.DrawPath($outline, $p) }
  $fb = if ($fill -eq 'orange') { Brush $OR } else { Brush $K0 }
  foreach ($p in $paths) { $g.FillPath($fb, $p) }
  $g.Dispose(); $script:cursors[$name] = @($b, $hx, $hy)
}
function U([float[]]$xy) { Poly ($xy | ForEach-Object { $_ * $u }) }
$arrowPts = @(2, 2, 2, 24, 7.5, 18.8, 11.5, 27.5, 15, 26, 11.2, 17.5, 18.2, 17.5)
Cursor 'arrow' (2/32) (2/32) { ,(U $arrowPts) }
Cursor 'link' (12/32) (2/32) {
  $a = @()
  $a += RR (10*$u) (2*$u) (4.2*$u) (16*$u) (2.1*$u)      # указательный
  $a += RR (14*$u) (10*$u) (3.8*$u) (9*$u) (1.9*$u)
  $a += RR (17.6*$u) (11*$u) (3.8*$u) (8*$u) (1.9*$u)
  $a += RR (21.2*$u) (12.5*$u) (3.6*$u) (7*$u) (1.8*$u)
  $a += RR (5*$u) (13*$u) (5.6*$u) (4*$u) (2*$u)        # большой
  $a += RR (8*$u) (15*$u) (16.8*$u) (13*$u) (4*$u)      # ладонь
  ,$a
}
Cursor 'ibeam' (16/32) (16/32) {
  $a = @(); $a += RR (15*$u) (6*$u) (2.2*$u) (20*$u) (0.8*$u); $a += RR (11*$u) (4.5*$u) (10.2*$u) (2.2*$u) (1*$u); $a += RR (11*$u) (25.3*$u) (10.2*$u) (2.2*$u) (1*$u); ,$a
} 'orange'
Cursor 'cross' (16/32) (16/32) { $a = @(); $a += RR (15*$u) (3*$u) (2.2*$u) (26*$u) (1*$u); $a += RR (3*$u) (15*$u) (26*$u) (2.2*$u) (1*$u); ,$a } 'orange'
# ожидание: кольцо с оранжевым сектором (статично)
function WaitRing($g, [float]$cx, [float]$cy, [float]$r) {
  $g.FillEllipse((Brush $K0), $cx - $r - 2*$u, $cy - $r - 2*$u, 2*$r + 4*$u, 2*$r + 4*$u)
  $g.DrawEllipse((New-Object Drawing.Pen $K3, (3*$u)), $cx - $r, $cy - $r, 2*$r, 2*$r)
  $p = New-Object Drawing.Pen $OR, (3*$u); $p.StartCap = 'Round'; $p.EndCap = 'Round'; $g.DrawArc($p, $cx - $r, $cy - $r, 2*$r, 2*$r, -90, 110)
}
$b, $g = Canvas $C; Prep $g 0.5 0.5; WaitRing $g (16*$u) (16*$u) (10*$u); $g.Dispose(); $cursors['wait'] = @($b, 0.5, 0.5)
$b, $g = Canvas $C; Prep $g (2/32) (2/32)
$o = New-Object Drawing.Pen $OR, (1.9*$u); $o.LineJoin = 'Round'; $ap = U $arrowPts; $g.DrawPath($o, $ap); $g.FillPath((Brush $K0), $ap)
WaitRing $g (23*$u) (24*$u) (5.5*$u); $g.Dispose(); $cursors['busy'] = @($b, (2/32), (2/32))
# запрещено
$b, $g = Canvas $C; Prep $g 0.5 0.5; $g.FillEllipse((Brush $K0), 4*$u, 4*$u, 24*$u, 24*$u); $p = New-Object Drawing.Pen $OR, (3*$u); $g.DrawEllipse($p, 6*$u, 6*$u, 20*$u, 20*$u); $g.DrawLine($p, 9*$u, 23*$u, 23*$u, 9*$u); $g.Dispose(); $cursors['no'] = @($b, 0.5, 0.5)
# стрелки изменения размера: одна двусторонняя стрелка, повёрнутая
function SizeCursor([string]$name, [float]$angle) {
  $b, $g = Canvas $C; Prep $g 0.5 0.5
  $g.TranslateTransform(16*$u, 16*$u); $g.RotateTransform($angle); $g.TranslateTransform(-16*$u, -16*$u)
  $p = U @(16, 3, 22, 10, 18, 10, 18, 22, 22, 22, 16, 29, 10, 22, 14, 22, 14, 10, 10, 10)
  $o = New-Object Drawing.Pen $OR, (1.9*$u); $o.LineJoin = 'Round'; $g.DrawPath($o, $p); $g.FillPath((Brush $K0), $p)
  $g.Dispose(); $script:cursors[$name] = @($b, 0.5, 0.5)
}
SizeCursor 'size-ns' 0; SizeCursor 'size-we' 90; SizeCursor 'size-nwse' -45; SizeCursor 'size-nesw' 45
$b, $g = Canvas $C; Prep $g 0.5 0.5
foreach ($ang in 0, 90) { $s = $g.Save(); $g.TranslateTransform(16*$u, 16*$u); $g.RotateTransform($ang); $g.TranslateTransform(-16*$u, -16*$u); $p = U @(16, 3, 21, 8.5, 17.5, 8.5, 17.5, 23.5, 21, 23.5, 16, 29, 11, 23.5, 14.5, 23.5, 14.5, 8.5, 11, 8.5); $o = New-Object Drawing.Pen $OR, (1.9*$u); $o.LineJoin = 'Round'; $g.DrawPath($o, $p); $g.Restore($s) }
foreach ($ang in 0, 90) { $s = $g.Save(); $g.TranslateTransform(16*$u, 16*$u); $g.RotateTransform($ang); $g.TranslateTransform(-16*$u, -16*$u); $p = U @(16, 3, 21, 8.5, 17.5, 8.5, 17.5, 23.5, 21, 23.5, 16, 29, 11, 23.5, 14.5, 23.5, 14.5, 8.5, 11, 8.5); $g.FillPath((Brush $K0), $p); $g.Restore($s) }
$g.Dispose(); $cursors['size-all'] = @($b, 0.5, 0.5)

foreach ($n in $cursors.Keys) { $c = $cursors[$n]; WriteIcoCur (Join-Path $curDir "$n.cur") $c[0] @(32, 48, 64) 2 $c[1] $c[2] }

# ---------- превью ----------
$cols = 8; $cell = 170
$rows = [Math]::Ceiling($icons.Count / $cols) + [Math]::Ceiling($cursors.Count / $cols)
$sheet = New-Object Drawing.Bitmap ($cols * $cell + 40), ($rows * $cell + 60), ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
$sg = [Drawing.Graphics]::FromImage($sheet); $sg.Clear([Drawing.Color]::FromArgb(255, 4, 4, 6)); $sg.InterpolationMode = 'HighQualityBicubic'; $sg.SmoothingMode = 'AntiAlias'
$font = New-Object Drawing.Font 'Segoe UI', 10; $i = 0
foreach ($n in $icons.Keys) { $x = 20 + ($i % $cols) * $cell; $y = 20 + [Math]::Floor($i / $cols) * $cell; $sg.DrawImage($icons[$n], $x + 25, $y, 120, 120); $sg.DrawString($n, $font, [Drawing.Brushes]::Gray, $x + 20, $y + 128); $i++ }
$i = [Math]::Ceiling($icons.Count / $cols) * $cols
foreach ($n in $cursors.Keys) { $x = 20 + ($i % $cols) * $cell; $y = 40 + [Math]::Floor($i / $cols) * $cell; $sg.DrawImage($cursors[$n][0], $x + 45, $y + 20, 80, 80); $sg.DrawString($n, $font, [Drawing.Brushes]::Gray, $x + 30, $y + 128); $i++ }
$sheet.Save((Join-Path $root 'preview.png'), [Drawing.Imaging.ImageFormat]::Png)
Write-Host ("Готово: {0} иконок, {1} курсоров" -f $icons.Count, $cursors.Count)
