# Рисует иконки в стиле ZALET HOME (чёрный фон, оранжевый акцент) и собирает .ico (PNG внутри, размеры 256/64/48/32/16).
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$OR = [Drawing.Color]::FromArgb(255, 255, 90, 31)
$BODY = [Drawing.Color]::FromArgb(255, 16, 16, 21)
$DEEP = [Drawing.Color]::FromArgb(255, 8, 8, 11)

function RR($x, $y, $w, $h, $r) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90); $p.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
  $p.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90); $p.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
  $p.CloseFigure(); return $p
}
function NewCanvas { $b = New-Object Drawing.Bitmap 256, 256, ([Drawing.Imaging.PixelFormat]::Format32bppArgb); $g = [Drawing.Graphics]::FromImage($b); $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::Transparent); return @($b, $g) }
function Draw($name, [scriptblock]$paint) {
  $b, $g = NewCanvas
  & $paint $g
  $g.Dispose()
  $b.Save((Join-Path $out "$name.png"), [Drawing.Imaging.ImageFormat]::Png)
  # .ico из нескольких размеров
  $sizes = 256, 64, 48, 32, 16; $pngs = @()
  foreach ($s in $sizes) {
    $r = New-Object Drawing.Bitmap $s, $s, ([Drawing.Imaging.PixelFormat]::Format32bppArgb); $gg = [Drawing.Graphics]::FromImage($r)
    $gg.InterpolationMode = 'HighQualityBicubic'; $gg.SmoothingMode = 'HighQuality'; $gg.PixelOffsetMode = 'HighQuality'; $gg.DrawImage($b, 0, 0, $s, $s); $gg.Dispose()
    $ms = New-Object IO.MemoryStream; $r.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $pngs += , $ms.ToArray(); $r.Dispose(); $ms.Dispose()
  }
  $fs = [IO.File]::Create((Join-Path $out "$name.ico")); $bw = New-Object IO.BinaryWriter $fs
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
  $off = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $wh = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$wh); $bw.Write([byte]$wh); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$off); $off += $pngs[$i].Length
  }
  foreach ($p in $pngs) { $bw.Write($p) }
  $bw.Close(); $fs.Close(); $b.Dispose()
}
function Stroke($g, $path, $w) { $pen = New-Object Drawing.Pen $OR, $w; $pen.LineJoin = 'Round'; $g.DrawPath($pen, $path); $pen.Dispose() }
function Fill($g, $path, $col) { $br = New-Object Drawing.SolidBrush $col; $g.FillPath($br, $path); $br.Dispose() }

Draw 'folder' { param($g)
  $tab = RR 22 46 100 52 12; Fill $g $tab $OR
  $shape = RR 22 72 212 142 18; Fill $g $shape $BODY; Stroke $g $shape 8
  $g.FillRectangle((New-Object Drawing.SolidBrush $OR), 40, 72, 176, 8)
}
Draw 'recycle-empty' { param($g)
  $lid = RR 44 56 168 26 10; Fill $g $lid $BODY; Stroke $g $lid 8
  $h = RR 104 36 48 24 8; Stroke $g $h 7
  $pts = [Drawing.PointF[]]@((New-Object Drawing.PointF 62, 92), (New-Object Drawing.PointF 194, 92), (New-Object Drawing.PointF 180, 216), (New-Object Drawing.PointF 76, 216))
  $bin = New-Object Drawing.Drawing2D.GraphicsPath; $bin.AddPolygon($pts); Fill $g $bin $BODY; Stroke $g $bin 8
  $pen = New-Object Drawing.Pen $OR, 7; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  foreach ($x in 104, 128, 152) { $g.DrawLine($pen, $x, 114, $x + (($x - 128) * 0.06), 194) }
}
Draw 'recycle-full' { param($g)
  # бумага торчит из корзины
  $paper = [Drawing.PointF[]]@((New-Object Drawing.PointF 70, 74), (New-Object Drawing.PointF 100, 26), (New-Object Drawing.PointF 128, 66), (New-Object Drawing.PointF 150, 22), (New-Object Drawing.PointF 186, 70), (New-Object Drawing.PointF 196, 92), (New-Object Drawing.PointF 62, 92))
  $pp = New-Object Drawing.Drawing2D.GraphicsPath; $pp.AddPolygon($paper); Fill $g $pp $OR
  $lid = RR 44 62 168 26 10; Fill $g $lid $BODY; Stroke $g $lid 8
  $pts = [Drawing.PointF[]]@((New-Object Drawing.PointF 62, 98), (New-Object Drawing.PointF 194, 98), (New-Object Drawing.PointF 180, 218), (New-Object Drawing.PointF 76, 218))
  $bin = New-Object Drawing.Drawing2D.GraphicsPath; $bin.AddPolygon($pts); Fill $g $bin $BODY; Stroke $g $bin 8
  $pen = New-Object Drawing.Pen $OR, 7; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  foreach ($x in 104, 128, 152) { $g.DrawLine($pen, $x, 120, $x + (($x - 128) * 0.06), 198) }
}
Draw 'drive' { param($g)
  $b = RR 18 92 220 84 20; Fill $g $b $BODY; Stroke $g $b 8
  $g.FillRectangle((New-Object Drawing.SolidBrush $OR), 44, 134, 96, 8)
  $g.FillEllipse((New-Object Drawing.SolidBrush $OR), 188, 124, 22, 22)
}
Draw 'pc' { param($g)
  $m = RR 26 38 204 138 16; Fill $g $m $BODY; Stroke $g $m 8
  $s = RR 44 56 168 102 6; Fill $g $s $DEEP
  $g.FillRectangle((New-Object Drawing.SolidBrush $OR), 108, 176, 40, 24)
  $base = RR 76 198 104 16 8; Fill $g $base $OR
}

# превью-лист
$sheet = New-Object Drawing.Bitmap 1360, 330, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
$sg = [Drawing.Graphics]::FromImage($sheet); $sg.Clear([Drawing.Color]::FromArgb(255, 4, 4, 6)); $sg.InterpolationMode = 'HighQualityBicubic'
$x = 30
foreach ($n in 'folder', 'recycle-empty', 'recycle-full', 'drive', 'pc') {
  $im = [Drawing.Image]::FromFile((Join-Path $out "$n.png")); $sg.DrawImage($im, $x, 30, 240, 240); $im.Dispose()
  $f = New-Object Drawing.Font 'Segoe UI', 11; $sg.DrawString($n, $f, [Drawing.Brushes]::Gray, $x + 70, 285); $x += 266
}
$sheet.Save((Join-Path $PSScriptRoot 'preview.png'), [Drawing.Imaging.ImageFormat]::Png); $sg.Dispose(); $sheet.Dispose()
Write-Host 'Иконки готовы:' $out