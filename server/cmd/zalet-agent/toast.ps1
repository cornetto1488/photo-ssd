$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ZaletWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
}
"@

$msg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZALET_MSG))
if ([string]::IsNullOrWhiteSpace($msg)) { exit 0 }
$secs = [Math]::Min(30, [Math]::Max(8, 6 + $msg.Length * 0.07))

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True"
        ShowInTaskbar="False" ShowActivated="False" SizeToContent="WidthAndHeight" ResizeMode="NoResize"
        UseLayoutRounding="True" TextOptions.TextFormattingMode="Display">
  <Grid Margin="26,26,26,34" x:Name="Root" Opacity="0" RenderTransformOrigin="0.5,0.5">
    <Grid.RenderTransform><TranslateTransform x:Name="Slide" X="60" Y="0"/></Grid.RenderTransform>
    <Border CornerRadius="22" Width="440" Background="#FF121216" BorderThickness="1" BorderBrush="#33FFFFFF" ClipToBounds="True">
      <Border.Effect><DropShadowEffect BlurRadius="34" ShadowDepth="10" Opacity="0.65" Color="#000000"/></Border.Effect>
      <Grid>
        <Ellipse Width="260" Height="260" HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,-130,-90,0" IsHitTestVisible="False">
          <Ellipse.Fill>
            <RadialGradientBrush><GradientStop Color="#33FF5A1F" Offset="0"/><GradientStop Color="#00FF5A1F" Offset="1"/></RadialGradientBrush>
          </Ellipse.Fill>
        </Ellipse>
        <StackPanel Margin="22,20,22,0">
          <Grid>
            <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
            <Border Width="40" Height="40" CornerRadius="12">
              <Border.Background>
                <LinearGradientBrush StartPoint="0,0" EndPoint="1,1"><GradientStop Color="#FFFF8A4C" Offset="0"/><GradientStop Color="#FFFF5A1F" Offset="1"/></LinearGradientBrush>
              </Border.Background>
              <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="0" Opacity="0.55" Color="#FF5A1F"/></Border.Effect>
              <Viewbox Width="22" Height="22">
                <Canvas Width="24" Height="24">
                  <Path Data="M3 11.5 12 4l9 7.5M5.5 9.6V20h13V9.6M10 20v-5.5h4V20M15.8 6.6V3.8h2.4v4.8" Stroke="#FF08080A" StrokeThickness="2.6" StrokeLineJoin="Round" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
                </Canvas>
              </Viewbox>
            </Border>
            <StackPanel Grid.Column="1" Margin="14,0,0,0" VerticalAlignment="Center">
              <StackPanel Orientation="Horizontal">
                <TextBlock Text="ZA" FontFamily="Segoe UI" FontWeight="ExtraBold" FontSize="17" Foreground="#FFFF5A1F"/>
                <TextBlock Text="LET" FontFamily="Segoe UI" FontWeight="ExtraBold" FontSize="17" Foreground="#FFF2F0ED"/>
                <TextBlock Text=" HOME" FontFamily="Consolas" FontSize="11" Foreground="#FF8C8C96" VerticalAlignment="Bottom" Margin="2,0,0,3"/>
              </StackPanel>
              <TextBlock Text="СООБЩЕНИЕ ИЗ ДОМА" FontFamily="Consolas" FontSize="10" Foreground="#FF8C8C96"/>
            </StackPanel>
            <TextBlock x:Name="Clock" Grid.Column="2" FontFamily="Consolas" FontSize="12" Foreground="#FF8C8C96" VerticalAlignment="Top" Margin="0,2,0,0"/>
          </Grid>
          <TextBlock x:Name="Body" Margin="0,16,0,0" TextWrapping="Wrap" FontFamily="Segoe UI" FontSize="19" FontWeight="SemiBold" Foreground="#FFF2F0ED" LineHeight="26"/>
          <Grid Margin="0,18,0,18">
            <Border Height="4" CornerRadius="2" Background="#FF1E1E24"/>
            <Border x:Name="Bar" Height="4" CornerRadius="2" HorizontalAlignment="Left" Width="396">
              <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="1,0"><GradientStop Color="#FFFF8A4C" Offset="0"/><GradientStop Color="#FFFF5A1F" Offset="1"/></LinearGradientBrush></Border.Background>
            </Border>
          </Grid>
        </StackPanel>
      </Grid>
    </Border>
  </Grid>
</Window>
"@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$root = $win.FindName('Root'); $slide = $win.FindName('Slide'); $win.FindName('Body').Text = $msg
$win.FindName('Clock').Text = (Get-Date).ToString('HH:mm')
$bar = $win.FindName('Bar')

$closing = $false
function Close-Toast {
  if ($script:closing) { return }; $script:closing = $true
  $fade = New-Object Windows.Media.Animation.DoubleAnimation(0, [TimeSpan]::FromMilliseconds(260))
  $fade.Add_Completed({ $win.Close() })
  $root.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
  $sl = New-Object Windows.Media.Animation.DoubleAnimation(40, [TimeSpan]::FromMilliseconds(260))
  $slide.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $sl)
}

$win.Add_SourceInitialized({
  # не забирать фокус и показываться поверх всех окон (в т.ч. над панелью задач)
  $h = (New-Object Windows.Interop.WindowInteropHelper $win).Handle
  $ex = [ZaletWin]::GetWindowLong($h, -20)
  [void][ZaletWin]::SetWindowLong($h, -20, ($ex -bor 0x08000000 -bor 0x80))  # WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
})
$win.Add_ContentRendered({
  $wa = [Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.ActualWidth + 12
  $win.Top = $wa.Bottom - $win.ActualHeight + 18
  $h = (New-Object Windows.Interop.WindowInteropHelper $win).Handle
  [void][ZaletWin]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040) # TOPMOST, без активации
  $in = New-Object Windows.Media.Animation.DoubleAnimation(1, [TimeSpan]::FromMilliseconds(320))
  $root.BeginAnimation([Windows.UIElement]::OpacityProperty, $in)
  $sl = New-Object Windows.Media.Animation.DoubleAnimation(0, [TimeSpan]::FromMilliseconds(420))
  $sl.EasingFunction = New-Object Windows.Media.Animation.CubicEase
  $slide.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $sl)
  $pb = New-Object Windows.Media.Animation.DoubleAnimation(0, [TimeSpan]::FromSeconds($secs))
  $bar.BeginAnimation([Windows.FrameworkElement]::WidthProperty, $pb)
  try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
})
$win.Add_MouseLeftButtonUp({ Close-Toast })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds($secs)
$timer.Add_Tick({ $timer.Stop(); Close-Toast })
$timer.Start()
$win.Add_Closed({ [Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })
$win.Show()
[Windows.Threading.Dispatcher]::Run()
