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
# плитка-основа для «системных» иконок
function Tile($g) { $t = RR 72 72 880 880 200; $g.FillPath((Brush $K1), $t); $g.DrawPath((New-Object Drawing.Pen $EDGE, 10), $t) }
$W = 54   # толщина линий глифов

# папка: тёмная, оранжевая вкладка и тонкая кромка, без обводки
function FolderBase($g) {
  $back = RR 90 170 844 700 70; $g.FillPath((Brush $K2), $back)
  $tab = RR 90 130 360 140 56; $g.FillPath((Brush $OR), $tab)
  $g.FillRectangle((Brush $K2), 90, 230, 844, 60)
  $front = RR 90 300 844 600 70; $g.FillPath((Brush $K1), $front)
  $g.FillRectangle((Brush $OR), 150, 300, 724, 18)
  $g.DrawPath((New-Object Drawing.Pen $EDGE, 8), $front)
}
function Glyph($g, [scriptblock]$draw) { $s = $g.Save(); $g.TranslateTransform(512, 620); & $draw $g; $g.Restore($s) }
Icon 'folder' { param($g) FolderBase $g }
Icon 'folder-docs' { param($g) FolderBase $g; Glyph $g { param($g) $p = Pen $OR 34; $g.DrawLine($p, -120, -60, 120, -60); $g.DrawLine($p, -120, 20, 120, 20); $g.DrawLine($p, -120, 100, 50, 100) } }
Icon 'folder-downloads' { param($g) FolderBase $g; Glyph $g { param($g) $p = Pen $OR 40; $g.DrawLine($p, 0, -130, 0, 70); $g.DrawLines($p, [Drawing.PointF[]]@((New-Object Drawing.PointF -80, -10), (New-Object Drawing.PointF 0, 70), (New-Object Drawing.PointF 80, -10))); $g.DrawLine($p, -130, 140, 130, 140) } }
Icon 'folder-pictures' { param($g) FolderBase $g; Glyph $g { param($g) $p = Pen $OR 34; $g.DrawLines($p, [Drawing.PointF[]]@((New-Object Drawing.PointF -150, 130), (New-Object Drawing.PointF -40, 10), (New-Object Drawing.PointF 40, 90), (New-Object Drawing.PointF 90, 40), (New-Object Drawing.PointF 150, 130))); $g.FillEllipse((Brush $OR), 60, -120, 70, 70) } }
Icon 'folder-music' { param($g) FolderBase $g; Glyph $g { param($g) $p = Pen $OR 34; $g.DrawLine($p, 40, -130, 40, 90); $g.DrawLine($p, 40, -130, 130, -100); $g.FillEllipse((Brush $OR), -60, 50, 120, 100) } }
Icon 'folder-videos' { param($g) FolderBase $g; Glyph $g { param($g) $tri = Poly @(-60, -100, 110, 0, -60, 100); $g.FillPath((Brush $OR), $tri) } }
Icon 'folder-desktop' { param($g) FolderBase $g; Glyph $g { param($g) $p = Pen $OR 30; $m = RR -140 -120 280 180 24; $g.DrawPath($p, $m); $g.DrawLine($p, 0, 60, 0, 120); $g.DrawLine($p, -70, 130, 70, 130) } }
Icon 'folder-zalet' { param($g) FolderBase $g; Glyph $g { param($g) $p = Pen $OR 36; $g.DrawLines($p, [Drawing.PointF[]]@((New-Object Drawing.PointF -130, 10), (New-Object Drawing.PointF 0, -110), (New-Object Drawing.PointF 130, 10))); $g.DrawLines($p, [Drawing.PointF[]]@((New-Object Drawing.PointF -95, -20), (New-Object Drawing.PointF -95, 130), (New-Object Drawing.PointF 95, 130), (New-Object Drawing.PointF 95, -20))) } }

# корзина: плитка, оранжевый контур, у полной — оранжевое содержимое
function Bin($g, [bool]$full) {
  Tile $g
  $p = Pen $OR $W
  if ($full) { $g.FillPath((Brush $OR), (Poly @(330, 330, 420, 230, 500, 300, 600, 220, 690, 330))) }
  $g.DrawLine($p, 290, 340, 734, 340)
  $g.DrawLines($p, [Drawing.PointF[]]@((New-Object Drawing.PointF 430, 340), (New-Object Drawing.PointF 450, 270), (New-Object Drawing.PointF 574, 270), (New-Object Drawing.PointF 594, 340)))
  $body = Poly @(340, 400, 684, 400, 650, 800, 374, 800)
  if ($full) { $g.FillPath((Brush $K2), $body) }
  $g.DrawPath($p, $body)
  $q = Pen $OR 36; foreach ($x in 450, 512, 574) { $g.DrawLine($q, $x, 480, $x + ($x - 512) * 0.12, 720) }
}
Icon 'recycle-empty' { param($g) Bin $g $false }
Icon 'recycle-full' { param($g) Bin $g $true }
Icon 'pc' { param($g) Tile $g; $p = Pen $OR $W; $m = RR 240 270 544 360 40; $g.DrawPath($p, $m); $g.DrawLine($p, 512, 630, 512, 730); $g.DrawLine($p, 400, 750, 624, 750) }
Icon 'drive' { param($g) Tile $g; $p = Pen $OR $W; $d = RR 220 380 584 264 60; $g.DrawPath($p, $d); $g.DrawLine($p, 310, 512, 520, 512); $g.FillEllipse((Brush $OR), 640, 478, 70, 70) }
Icon 'network' { param($g) Tile $g; $p = Pen $OR 44; $g.DrawEllipse($p, 292, 292, 440, 440); $g.DrawEllipse($p, 420, 292, 184, 440); $g.DrawLine($p, 292, 512, 732, 512) }
Icon 'user' { param($g) Tile $g; $p = Pen $OR $W; $g.DrawEllipse($p, 402, 250, 220, 220); $g.DrawArc($p, 290, 540, 444, 380, 200, 140) }
Icon 'zalet' { param($g) Tile $g; $p = Pen $OR $W; $g.DrawLines($p, [Drawing.PointF[]]@((New-Object Drawing.PointF 270, 520), (New-Object Drawing.PointF 512, 300), (New-Object Drawing.PointF 754, 520))); $g.DrawLines($p, [Drawing.PointF[]]@((New-Object Drawing.PointF 330, 470), (New-Object Drawing.PointF 330, 760), (New-Object Drawing.PointF 694, 760), (New-Object Drawing.PointF 694, 470))); $g.FillRectangle((Brush $OR), 470, 600, 84, 160) }

foreach ($n in $icons.Keys) { WriteIcoCur (Join-Path $icoDir "$n.ico") $icons[$n] @(256, 64, 48, 32, 24, 16) 1 0 0 }

# ---------- курсоры: рисуем на 256 (= 32 px * 8), сохраняем 32/48/64/96/128 ----------
$C = 256; $u = 8.0
$cursors = [ordered]@{}
# всё, что рисуется: сначала толстый оранжевый контур всех фигур, потом заливка — получается единая аккуратная обводка
function Cursor([string]$name, [float]$hx, [float]$hy, [scriptblock]$shapes, [string]$fill = 'black') {
  $b, $g = Canvas $C
  $paths = & $shapes
  $outline = New-Object Drawing.Pen $OR, (2.6 * $u); $outline.LineJoin = 'Round'
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
$b, $g = Canvas $C; WaitRing $g (16*$u) (16*$u) (10*$u); $g.Dispose(); $cursors['wait'] = @($b, 0.5, 0.5)
$b, $g = Canvas $C
$o = New-Object Drawing.Pen $OR, (2.6*$u); $o.LineJoin = 'Round'; $ap = U $arrowPts; $g.DrawPath($o, $ap); $g.FillPath((Brush $K0), $ap)
WaitRing $g (23*$u) (24*$u) (5.5*$u); $g.Dispose(); $cursors['busy'] = @($b, (2/32), (2/32))
# запрещено
$b, $g = Canvas $C; $g.FillEllipse((Brush $K0), 4*$u, 4*$u, 24*$u, 24*$u); $p = New-Object Drawing.Pen $OR, (3*$u); $g.DrawEllipse($p, 6*$u, 6*$u, 20*$u, 20*$u); $g.DrawLine($p, 9*$u, 23*$u, 23*$u, 9*$u); $g.Dispose(); $cursors['no'] = @($b, 0.5, 0.5)
# стрелки изменения размера: одна двусторонняя стрелка, повёрнутая
function SizeCursor([string]$name, [float]$angle) {
  $b, $g = Canvas $C
  $g.TranslateTransform(16*$u, 16*$u); $g.RotateTransform($angle); $g.TranslateTransform(-16*$u, -16*$u)
  $p = U @(16, 3, 22, 10, 18, 10, 18, 22, 22, 22, 16, 29, 10, 22, 14, 22, 14, 10, 10, 10)
  $o = New-Object Drawing.Pen $OR, (2.6*$u); $o.LineJoin = 'Round'; $g.DrawPath($o, $p); $g.FillPath((Brush $K0), $p)
  $g.Dispose(); $script:cursors[$name] = @($b, 0.5, 0.5)
}
SizeCursor 'size-ns' 0; SizeCursor 'size-we' 90; SizeCursor 'size-nwse' -45; SizeCursor 'size-nesw' 45
$b, $g = Canvas $C
foreach ($ang in 0, 90) { $s = $g.Save(); $g.TranslateTransform(16*$u, 16*$u); $g.RotateTransform($ang); $g.TranslateTransform(-16*$u, -16*$u); $p = U @(16, 3, 21, 8.5, 17.5, 8.5, 17.5, 23.5, 21, 23.5, 16, 29, 11, 23.5, 14.5, 23.5, 14.5, 8.5, 11, 8.5); $o = New-Object Drawing.Pen $OR, (2.6*$u); $o.LineJoin = 'Round'; $g.DrawPath($o, $p); $g.Restore($s) }
foreach ($ang in 0, 90) { $s = $g.Save(); $g.TranslateTransform(16*$u, 16*$u); $g.RotateTransform($ang); $g.TranslateTransform(-16*$u, -16*$u); $p = U @(16, 3, 21, 8.5, 17.5, 8.5, 17.5, 23.5, 21, 23.5, 16, 29, 11, 23.5, 14.5, 23.5, 14.5, 8.5, 11, 8.5); $g.FillPath((Brush $K0), $p); $g.Restore($s) }
$g.Dispose(); $cursors['size-all'] = @($b, 0.5, 0.5)

foreach ($n in $cursors.Keys) { $c = $cursors[$n]; WriteIcoCur (Join-Path $curDir "$n.cur") $c[0] @(32, 48, 64, 96, 128) 2 $c[1] $c[2] }

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
