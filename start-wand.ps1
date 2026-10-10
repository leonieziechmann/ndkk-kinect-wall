<#
  start-wand.ps1: starts everything the LED wall needs and tunes Windows for it, only while it runs.

    start-wand.cmd                     double-click (or the desktop icon "Kinect-Wand starten")
    .\start-wand.ps1 [-NoWall] [-NoControl] [-Hub 8091] [-RecordMinutes 5] [-Minimal]
    .\start-wand.ps1 -Panic            NOTAUS (also Strg+Alt+Shift+N, desktop icon "Kinect-Wand NOTAUS")

  Starts (or reuses, if they already run) from the main checkout: kinect-hub (real Kinect, :8090),
  the Vite dev server of web/ (show, control center), the output window /wall/ as a kiosk window on
  the LED screen (the same as npm run wall) and the control center /control/ on the notebook's own
  panel. A watchdog restarts what dies.

  The displays are found automatically every time (no setting): the output window only ever goes to
  the second display, never the notebook's own panel (with several other displays the one named in
  the wall setup, else the leftmost); with no second display it stays closed until one is plugged
  in. Where it really is gets checked twice a second: a wall window on the notebook's panel (Windows
  moves it there when the LED screen goes away) is closed at once. The control center opens as an
  app window of its own, maximized on the notebook's panel; with the lid closed (no notebook panel)
  it stays closed, so it never covers the wall.

  R records training data while the show goes on: RecordMinutes (5) of depth and infrared from the
  running hub (kinect-hub-probe record, never the sensor itself) into recordings\wand-<date>-<time>.k2rec
  of the checkout, about 20 MB/s (5 min = 5.5 GB). Only after a yes (consent asked?) and only if the
  disk keeps 5 GB free after it; the recorder runs hidden below normal priority (the show goes first)
  and is stopped below 2 GB free. R again stops it early: kept or deleted. Q, NOTAUS and the guard
  stop it too and keep what it has. A recording ended early is cut back to its last whole frame.

  Tunes while it runs:
    - power plan: a temporary copy of "High performance": no sleep, no display off, lid closed = do
      nothing, USB selective suspend and PCIe link power saving off (Kinect), CPU min 100 %, boost
    - no sleep or display off (SetThreadExecutionState, ends with this process)
    - priorities: hub, depth worker and the kiosk browser above normal (the same level, so neither
      waits for the other), never in efficiency mode; chat/sync apps (Teams, WhatsApp, Signal, Phone
      Link, OneDrive, ...), test hubs, headless test browsers and the dev servers of other worktrees in
      efficiency mode (idle + EcoQoS)
  Windows services stay as they are: Windows starts the search indexer and Windows Update again
  within seconds, so stopping them only made them start over and over (more load, not less).

  Costs next to nothing itself (it shares the notebook with the show): the loop sleeps until a key
  or the next check; processes, windows and the hub are read with a few native calls (no WMI, no
  process lists in PowerShell); the graphics driver is asked about the displays only when the
  monitors change; the screen redraws only lines that changed; the C# part is compiled once and
  cached, so neither a start nor the guard nor NOTAUS runs the compiler.

  -Minimal (desktop icon "Kinect-Wand starten (minimal)"), for when the show stutters now and then:
  everything that could take time or power from it stays off.
    - power plan: a copy of Windows' "Balanced" with only what the show needs (no sleep, display
      on, lid closed = do nothing, USB selective suspend and PCIe link power saving off). The CPU
      gets no minimum clock and no forced boost: on this APU the CPU and the integrated GPU share
      one power and heat budget, and a CPU held at full clock takes it from the GPU (the notebook
      heats up, then both throttle)
    - no priorities or efficiency mode (no process lists), no "Viel CPU"
    - the graphics driver is asked about the displays only when they change (not once a minute);
      the wall window's place every 2 s (all windows every 10 s); the hub and the screen every 30 s

  Getting the old values back, whatever happens:
    - every original value is written to %LOCALAPPDATA%\kinect-wand\journal.json BEFORE it is changed
    - Q here: everything back, and what this program started is stopped
    - this window closed or the program crashed: a hidden guard process does the same
    - NOTAUS Strg+Alt+Shift+N (the guard; works in every window) or the desktop icon: ends this
      program, puts everything back, stops what it started
    - PC crashed, restarted or signed out: priorities, efficiency mode and the sleep block end with
      their processes; the power plan comes back at the next sign-in (RunOnce); the next start of
      this program cleans up what is left in the journal
#>
[CmdletBinding()]
param(
  [switch]$NoWall,    # no output window (e.g. without the LED screen)
  [switch]$NoControl, # no control center window on the notebook
  [int]$Hub = 8090,   # the hub to use; only the real one on 8090 is started, others must run already
  [ValidateRange(1, 60)][int]$RecordMinutes = 5,   # R: length of a recording (training data)
  [switch]$Minimal,   # nothing that could take time or power from the show (see above)
  [switch]$Panic,     # NOTAUS
  [int]$Guard = 0,    # internal: be the guard of this PID
  [string]$Checkout,  # for tests: use this checkout instead of the main one
  [switch]$NoAdmin    # no effect any more (nothing needs admin rights); kept for old command lines
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$StateDir = Join-Path $env:LOCALAPPDATA 'kinect-wand'
$LogDir = Join-Path $StateDir 'logs'
$JournalFile = Join-Path $StateDir 'journal.json'
$HotkeyFile = Join-Path $StateDir 'hotkey.txt'
$GuardStopFlag = Join-Path $StateDir 'guard-stop.flag'
$QuitFlag = Join-Path $StateDir 'quit.flag'      # written by anyone: the main program ends cleanly (as with Q)
$EventLog = Join-Path $StateDir 'start-wand.log'
# stdin of the hub and the dev server: without it, Start-Process hands them this console's input,
# Vite reads it as a terminal and takes the events [Console]::KeyAvailable waits for (it hangs)
$NoInput = Join-Path $StateDir 'no-input.txt'
$RunOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$RunOnceName = 'KinectWandEnergieplan'
$PowerName = 'Kinect-Wand (Startskript)'
$HighPerf = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
$Balanced = '381b4222-f694-41f0-9685-ff5bb260df2e'
$HotkeyText = 'Strg+Alt+Shift+N'
$HotkeyMods = 0x0002 -bor 0x0001 -bor 0x0004   # MOD_CONTROL | MOD_ALT | MOD_SHIFT
$HotkeyVk = 0x4E                                # N
# recordings (R): depth u16 and infrared u8 of 512 x 424 pixels at 30 fps, 19.6 MB per second; one
# starts only if the disk keeps RecordReserve free after it, and is stopped below RecordMinFree
$RecordRate = 19.6e6
$RecordReserve = 5GB
$RecordMinFree = 2GB

# apps put into efficiency mode while the show runs (process names without .exe; also their WebView2)
$BackgroundApps = @('ms-teams', 'Teams', 'WhatsApp', 'WhatsApp.Root', 'Signal', 'PhoneExperienceHost',
  'CrossDeviceService', 'OneDrive', 'Spotify', 'Discord', 'Dropbox', 'GoogleDriveFS', 'Widgets',
  'WidgetService', 'Telegram', 'slack', 'Zoom', 'olk', 'OUTLOOK', 'steam', 'steamwebhelper',
  'EpicGamesLauncher', 'EADesktop', 'Battle.net')
# power plan values: subgroup, setting, AC, DC ($null: as in the base plan), and whether -Minimal sets
# it too (what the show needs; the others are for speed)
$PowerSettings = @(
  @('238c9fa8-0aad-41ed-83f4-97be242c8f20', '29f6c1db-86da-48c5-9fdb-f2b67b1f44da', 0, 0, $true),        # sleep after: never
  @('238c9fa8-0aad-41ed-83f4-97be242c8f20', '9d7815a6-7ee4-497e-8888-515a05f02364', 0, 0, $true),        # hibernate after: never
  @('7516b95f-f776-4464-8c53-06167f40cc99', '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e', 0, 0, $true),        # display off after: never
  @('7516b95f-f776-4464-8c53-06167f40cc99', '17aaa29b-8b43-4b94-aafe-35f64daaf1ee', 0, 0, $true),        # dim display after: never
  @('0012ee47-9041-4b5d-9b77-535fba8b1442', '6738e2c4-e8a5-4a42-b16a-e040e769756e', 0, 0, $true),        # disk off after: never
  @('4f971e89-eebd-4455-a8de-9e59040e7347', '5ca83367-6e45-459f-a27b-476b1d01c936', 0, 0, $true),        # lid closed: do nothing
  @('2a737441-1930-4402-8d77-b2bebba308a3', '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', 0, 0, $true),        # USB selective suspend: off
  @('501a4d13-42af-4429-9fd1-a8218c268e20', 'ee12f906-d277-404b-b6da-e5fa1a576df5', 0, 0, $true),        # PCIe link power saving: off
  @('54533251-82be-4824-96c1-47b60b740d00', '893dee8e-2bef-41e0-89c6-b55d0929964c', 100, $null, $false), # min processor state: 100 %
  @('54533251-82be-4824-96c1-47b60b740d00', 'be337238-0d82-4146-a960-4f3749d470c7', 2, $null, $false),   # processor boost: aggressive
  @('19cbb8fa-5279-450e-9fac-8a3d5fedd0c1', '12bbebe6-58d6-4636-95bb-3217ef867c1a', 0, 0, $false),       # Wi-Fi power saving: off
  @('de830923-a562-41af-a086-e3a2c6bad2da', 'e69653ca-cf7f-4f05-aa73-cb833fa90ad4', $null, 0, $true)     # energy saver from battery level: never
)

$NativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;

public static class KinectWandNative {
  [StructLayout(LayoutKind.Sequential)] struct Throttling { public uint Version; public uint ControlMask; public uint StateMask; }
  [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MemStatus { public uint Length; public uint Load; public ulong TotalPhys; public ulong AvailPhys; public ulong TotalPage; public ulong AvailPage; public ulong TotalVirtual; public ulong AvailVirtual; public ulong AvailExtended; }
  [StructLayout(LayoutKind.Sequential)] struct PowerStatus { public byte AcLine; public byte Flag; public byte Percent; public byte Saver; public int LifeTime; public int FullLifeTime; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr h, int cls, ref Throttling info, int size);
  [DllImport("kernel32.dll")] static extern bool GetProcessInformation(IntPtr h, int cls, ref Throttling info, int size);
  [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr h, uint cls);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MemStatus m);
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus s);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hwnd, int id);
  [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms, uint mask);
  [DllImport("user32.dll")] static extern bool PeekMessage(out Msg m, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int MessageBox(IntPtr hwnd, string text, string caption, uint type);

  const int ProcessPowerThrottling = 4;
  const uint SET_INFO = 0x0200, QUERY_LIMITED = 0x1000, SYNCHRONIZE = 0x00100000;

  // The process's power throttling as it is: (ControlMask << 32) | StateMask, -1 if unknown. Bit 0
  // is efficiency mode (EcoQoS); Windows and apps also use other bits (timer resolution), so
  // the whole value is what gets restored.
  public static long GetThrottle(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return -1;
    try {
      var s = new Throttling { Version = 1 };
      if (!GetProcessInformation(h, ProcessPowerThrottling, ref s, Marshal.SizeOf(s))) return -1;
      return ((long)s.ControlMask << 32) | s.StateMask;
    } finally { CloseHandle(h); }
  }

  public static bool SetThrottle(int pid, long raw) {
    if (raw < 0) return false;
    IntPtr h = OpenProcess(SET_INFO, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      var s = new Throttling { Version = 1, ControlMask = (uint)(raw >> 32), StateMask = (uint)(raw & 0xffffffffL) };
      return SetProcessInformation(h, ProcessPowerThrottling, ref s, Marshal.SizeOf(s));
    } finally { CloseHandle(h); }
  }

  // Efficiency mode on (true) or explicitly off (false); the other bits stay as they are.
  public static bool SetEco(int pid, bool on) {
    long raw = GetThrottle(pid);
    long control = (raw < 0 ? 0 : raw >> 32) | 1;
    long state = raw < 0 ? 0 : raw & 0xffffffffL;
    state = on ? (state | 1) : (state & ~1L);
    return SetThrottle(pid, (control << 32) | state);
  }

  // Priority class by the names .NET uses ("Normal", "AboveNormal", ...); null if unknown.
  static readonly string[] prioNames = { "Idle", "BelowNormal", "Normal", "AboveNormal", "High", "RealTime" };
  static readonly uint[] prioValues = { 0x40, 0x4000, 0x20, 0x8000, 0x80, 0x100 };

  public static string GetPriority(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      uint c = GetPriorityClass(h);
      int i = Array.IndexOf(prioValues, c);
      return i < 0 ? null : prioNames[i];
    } finally { CloseHandle(h); }
  }

  public static bool SetPriority(int pid, string name) {
    int i = Array.IndexOf(prioNames, name);
    if (i < 0) return false;
    IntPtr h = OpenProcess(SET_INFO, false, pid);
    if (h == IntPtr.Zero) return false;
    try { return SetPriorityClass(h, prioValues[i]); } finally { CloseHandle(h); }
  }

  // No sleep, display stays on, as long as this thread runs (ES_CONTINUOUS | SYSTEM | DISPLAY).
  public static void KeepAwake(bool on) { SetThreadExecutionState(on ? 0x80000003u : 0x80000000u); }

  static long lastIdle, lastTotal;
  public static double CpuPercent() {
    long idle, kernel, user;
    if (!GetSystemTimes(out idle, out kernel, out user)) return -1;
    long total = kernel + user;
    double r = -1;
    if (lastTotal > 0 && total > lastTotal) r = 100.0 * (1.0 - (double)(idle - lastIdle) / (total - lastTotal));
    lastIdle = idle; lastTotal = total;
    return r;
  }

  public static double FreeMemoryGB() {
    var m = new MemStatus { Length = (uint)Marshal.SizeOf(typeof(MemStatus)) };
    return GlobalMemoryStatusEx(ref m) ? m.AvailPhys / 1073741824.0 : -1;
  }

  public static string Power() {
    PowerStatus s;
    if (!GetSystemPowerStatus(out s)) return "?";
    bool battery = (s.Flag & 128) == 0 && s.Percent <= 100;
    if (s.AcLine == 1) return "Netzteil" + (battery ? " (Akku " + s.Percent + " %)" : "");
    return "AKKU " + (battery ? s.Percent + " %" : "");
  }

  // The guard: waits until process pid ends ("exit"), the hotkey is pressed ("panic") or the stop
  // flag appears ("quit"). Writes "ok" or "busy" (hotkey taken by another program) to hotkeyFile.
  public static string Guard(int pid, string stopFlag, string hotkeyFile, uint mods, uint vk) {
    IntPtr h = OpenProcess(SYNCHRONIZE, false, pid);
    if (h == IntPtr.Zero) return "exit";
    bool hot = RegisterHotKey(IntPtr.Zero, 1, mods | 0x4000, vk);
    try { File.WriteAllText(hotkeyFile, hot ? "ok" : "busy"); } catch { }
    try {
      while (true) {
        uint r = MsgWaitForMultipleObjects(1, new[] { h }, false, 1000, 0x04FF);
        if (r == 0) return "exit";
        Msg m;
        while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) {
          if (m.message == 0x0312) return "panic";
        }
        if (File.Exists(stopFlag)) return "quit";
      }
    } finally {
      if (hot) UnregisterHotKey(IntPtr.Zero, 1);
      CloseHandle(h);
    }
  }

  public static void Show(string text, bool warn) {
    MessageBox(IntPtr.Zero, text, "Kinect-Wand", 0x00040000u | 0x00010000u | (warn ? 0x30u : 0x40u));
  }

  // ---- displays: where the output window may go (never the notebook's own panel)

  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct PathSource { public Luid adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] struct PathTarget { public Luid adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling; public uint refreshNum; public uint refreshDen; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] struct PathInfo { public PathSource source; public PathTarget target; public uint flags; }
  [StructLayout(LayoutKind.Explicit, Size = 64)] struct ModeInfo {
    [FieldOffset(0)] public uint infoType; [FieldOffset(4)] public uint id; [FieldOffset(8)] public Luid adapterId;
    [FieldOffset(16)] public uint width; [FieldOffset(20)] public uint height; [FieldOffset(24)] public uint pixelFormat;
    [FieldOffset(28)] public int x; [FieldOffset(32)] public int y;
  }
  [StructLayout(LayoutKind.Sequential)] struct InfoHeader { public uint type; public uint size; public Luid adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SourceName { public InfoHeader header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string gdiName; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct TargetName { public InfoHeader header; public uint flags; public uint outputTechnology; public ushort edidManufactureId; public ushort edidProductCodeId; public uint connectorInstance; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string friendlyName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string devicePath; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MonitorInfoEx { public int cbSize; public Rect monitor; public Rect work; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string device; }
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  delegate bool MonitorEnumProc(IntPtr m, IntPtr dc, ref Rect r, IntPtr data);

  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PathInfo[] paths, ref uint numModes, [Out] ModeInfo[] modes, IntPtr topology);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SourceName r);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref TargetName r);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MonitorInfoEx mi);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  public class Display { public string Device; public string Name; public int X, Y, Width, Height; public bool Internal; public uint Technology; }

  // The active displays: GDI name, place on the desktop in physical pixels, the monitor's name and
  // whether it is the notebook's own panel (connected as LVDS, embedded DisplayPort, embedded UDI
  // or "internal"). Asks the graphics driver: use Screens() for anything that runs often.
  public static Display[] Displays() {
    uint np, nm;
    if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return new Display[0];
    var paths = new PathInfo[np];
    var modes = new ModeInfo[nm];
    if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return new Display[0];
    var list = new List<Display>();
    for (int i = 0; i < np; i++) {
      var p = paths[i];
      uint t = p.target.outputTechnology;
      var d = new Display { Technology = t, Internal = t == 6 || t == 11 || t == 13 || t == 0x80000000u };
      uint m = p.source.modeInfoIdx;
      if (m < nm && modes[m].infoType == 1) { d.X = modes[m].x; d.Y = modes[m].y; d.Width = (int)modes[m].width; d.Height = (int)modes[m].height; }
      var sn = new SourceName();
      sn.header.type = 1; sn.header.size = (uint)Marshal.SizeOf(typeof(SourceName)); sn.header.adapterId = p.source.adapterId; sn.header.id = p.source.id;
      if (DisplayConfigGetDeviceInfo(ref sn) == 0) d.Device = sn.gdiName;
      var tn = new TargetName();
      tn.header.type = 2; tn.header.size = (uint)Marshal.SizeOf(typeof(TargetName)); tn.header.adapterId = p.target.adapterId; tn.header.id = p.target.id;
      if (DisplayConfigGetDeviceInfo(ref tn) == 0) d.Name = tn.friendlyName;
      list.Add(d);
    }
    return list.ToArray();
  }

  static readonly Stopwatch clock = Stopwatch.StartNew();
  static Display[] screens = new Display[0];
  static string screensKey;
  static long screensAt = -1;
  static Dictionary<IntPtr, string> monitorDevice = new Dictionary<IntPtr, string>();
  static HashSet<IntPtr> internalMonitors = new HashSet<IntPtr>();
  public static int ScreensVersion;   // goes up whenever Displays() was asked again
  public static bool ScreensEachMinute = true;   // false (-Minimal): only when the monitors changed

  // Displays(), cheap to call often: the graphics driver is asked only when the monitors changed
  // (names and places from EnumDisplayMonitors, which Windows keeps at hand) and once a minute.
  public static Display[] Screens() {
    var mons = new Dictionary<IntPtr, string>();
    var key = new StringBuilder();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr m, IntPtr dc, ref Rect r, IntPtr data) {
      var mi = new MonitorInfoEx { cbSize = Marshal.SizeOf(typeof(MonitorInfoEx)) };
      if (GetMonitorInfo(m, ref mi)) {
        mons[m] = mi.device;
        key.Append(mi.device).Append(' ').Append(mi.monitor.Left).Append(',').Append(mi.monitor.Top).Append(',')
          .Append(mi.monitor.Right).Append(',').Append(mi.monitor.Bottom).Append(';');
      }
      return true;
    }, IntPtr.Zero);
    string k = key.ToString();
    long now = clock.ElapsedMilliseconds;
    if (k != screensKey || screensAt < 0 || (ScreensEachMinute && now - screensAt > 60000)) {
      var all = Displays();
      // in the middle of a change the driver may answer with nothing: ask again next time
      if (all.Length > 0 || mons.Count == 0) { screens = all; screensKey = k; screensAt = now; ScreensVersion++; }
    }
    var inner = new HashSet<string>();
    foreach (var s in screens) if (s.Internal && s.Device != null) inner.Add(s.Device);
    var im = new HashSet<IntPtr>();
    foreach (var kv in mons) if (inner.Contains(kv.Value)) im.Add(kv.Key);
    monitorDevice = mons;
    internalMonitors = im;
    return screens;
  }

  // GDI name ("\\.\DISPLAY2") of the display that shows the largest visible window of process
  // pid, null while it has none.
  public static string WindowDisplay(int pid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((h, l) => {
      uint wp;
      GetWindowThreadProcessId(h, out wp);
      Rect r;
      if (wp == (uint)pid && IsWindowVisible(h) && GetWindowRect(h, out r)) {
        long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (a > bestArea) { bestArea = a; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return null;
    var mi = new MonitorInfoEx { cbSize = Marshal.SizeOf(typeof(MonitorInfoEx)) };
    return GetMonitorInfo(MonitorFromWindow(best, 2), ref mi) ? mi.device : null;
  }

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);

  public static string OurDevice;   // display of the largest window of ourPid at the last WallScan
  public static int PlaceVersion;   // goes up when OurDevice or the displays changed
  static int placeScreens = -1;
  static List<IntPtr> ourWindows = new List<IntPtr>();   // visible windows of ourPid at the last full scan
  static int ourWindowsPid;

  // No wall window on the notebook's own panel: sends WM_CLOSE to every visible window (larger than
  // 100 x 100) there that belongs to ourPid or to another browser with the wall profile, and returns
  // those processes. Notes where the largest window of ourPid is (OurDevice). full: one pass over
  // all windows; otherwise only the windows of ourPid found by the last full pass (a few calls; a
  // full pass happens anyway when one of them is gone).
  public static int[] WallScan(int ourPid, string profile, bool full) {
    Screens();
    var inner = internalMonitors;
    var bad = new List<int>();
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    if (!full && ourPid == ourWindowsPid) {
      foreach (var h in ourWindows) {
        uint wp;
        if (!IsWindow(h) || GetWindowThreadProcessId(h, out wp) == 0 || wp != (uint)ourPid) { full = true; break; }
        Rect r;
        if (!IsWindowVisible(h) || !GetWindowRect(h, out r)) continue;
        long w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w * ht > bestArea) { bestArea = w * ht; best = h; }
        if (w > 100 && ht > 100 && inner.Count > 0 && inner.Contains(MonitorFromWindow(h, 2))) {
          PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
          if (!bad.Contains(ourPid)) bad.Add(ourPid);
        }
      }
    } else full = true;
    if (full) {
      bad.Clear(); best = IntPtr.Zero; bestArea = 0;
      profile = profile.ToLowerInvariant().Replace('/', '\\');
      var mine = new List<IntPtr>();
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h)) return true;
        Rect r;
        if (!GetWindowRect(h, out r)) return true;
        uint wp;
        GetWindowThreadProcessId(h, out wp);
        bool ours = ourPid != 0 && wp == (uint)ourPid;
        long w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (ours) { mine.Add(h); if (w * ht > bestArea) { bestArea = w * ht; best = h; } }
        if (w <= 100 || ht <= 100 || inner.Count == 0) return true;
        if (!inner.Contains(MonitorFromWindow(h, 2))) return true;
        if (ours || IsWallBrowser((int)wp, profile)) {
          PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
          if (!bad.Contains((int)wp)) bad.Add((int)wp);
        }
        return true;
      }, IntPtr.Zero);
      ourWindows = mine;
      ourWindowsPid = ourPid;
    }
    string dev = null;
    if (best != IntPtr.Zero) {
      IntPtr m = MonitorFromWindow(best, 2);
      if (!monitorDevice.TryGetValue(m, out dev)) {
        var mi = new MonitorInfoEx { cbSize = Marshal.SizeOf(typeof(MonitorInfoEx)) };
        dev = GetMonitorInfo(m, ref mi) ? mi.device : null;
      }
    }
    if (dev != OurDevice || placeScreens != ScreensVersion) { PlaceVersion++; placeScreens = ScreensVersion; }
    OurDevice = dev;
    return bad.ToArray();
  }

  // Is this process the main process of a browser with the wall profile (ours, or one the control
  // center opened)? Looked up once per process, then remembered.
  static Dictionary<int, KeyValuePair<long, bool>> wallBrowser = new Dictionary<int, KeyValuePair<long, bool>>();
  static bool IsWallBrowser(int pid, string profile) {
    long start = StartTime(pid);
    if (start < 0) return false;
    KeyValuePair<long, bool> known;
    if (wallBrowser.TryGetValue(pid, out known) && known.Key == start) return known.Value;
    bool wall = false;
    string name = ImageName(pid);
    if (name == "chrome.exe" || name == "msedge.exe") {
      string cl = CommandLine(pid);
      if (cl != null) {
        cl = cl.ToLowerInvariant().Replace('/', '\\');
        wall = cl.Contains(profile) && !cl.Contains("--type=");
      }
    }
    if (wallBrowser.Count > 2000) wallBrowser.Clear();
    wallBrowser[pid] = new KeyValuePair<long, bool>(start, wall);
    return wall;
  }

  // ---- processes, cheaply (no WMI, no Get-Process: those list and open every process each time)

  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);

  public class Proc { public int Pid; public int Parent; public string Name; public long Start; public long Cpu; }

  static IntPtr snapBuf = IntPtr.Zero;
  static int snapLen;

  // Every process in one call (SystemProcessInformation, as Task Manager reads it): file name,
  // parent, start time and CPU time, without opening a single process.
  static List<Proc> Snapshot() {
    var list = new List<Proc>();
    int p = IntPtr.Size;   // SYSTEM_PROCESS_INFORMATION: offsets after ImageName depend on it
    for (int tries = 0; tries < 5; tries++) {
      if (snapBuf == IntPtr.Zero) { snapLen = 1 << 20; snapBuf = Marshal.AllocHGlobal(snapLen); }
      int need;
      int status = NtQuerySystemInformation(5, snapBuf, snapLen, out need);
      if (status == unchecked((int)0xC0000004)) {   // STATUS_INFO_LENGTH_MISMATCH
        Marshal.FreeHGlobal(snapBuf);
        snapLen = Math.Max(need, snapLen) + (1 << 18);
        snapBuf = Marshal.AllocHGlobal(snapLen);
        continue;
      }
      if (status != 0) return list;
      long at = snapBuf.ToInt64();
      while (true) {
        var e = new IntPtr(at);
        int pid = (int)Marshal.ReadIntPtr(e, 0x38 + 3 * p).ToInt64();
        if (pid != 0) {
          int nameBytes = (ushort)Marshal.ReadInt16(e, 0x38);
          IntPtr name = Marshal.ReadIntPtr(e, 0x38 + p);
          list.Add(new Proc {
            Pid = pid, Parent = (int)Marshal.ReadIntPtr(e, 0x38 + 4 * p).ToInt64(),
            Name = nameBytes > 0 && name != IntPtr.Zero ? Marshal.PtrToStringUni(name, nameBytes / 2) : "",
            Start = Marshal.ReadInt64(e, 0x20), Cpu = Marshal.ReadInt64(e, 0x28) + Marshal.ReadInt64(e, 0x30)
          });
        }
        int next = Marshal.ReadInt32(e, 0);
        if (next == 0) break;
        at += next;
      }
      return list;
    }
    return list;
  }

  // The running processes with one of these file names (e.g. "chrome.exe").
  public static Proc[] Processes(string[] names) {
    var want = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
    var list = new List<Proc>();
    foreach (var p in Snapshot()) if (want.Contains(p.Name)) list.Add(p);
    return list.ToArray();
  }

  // Like Processes, but each process only once: the ones this function has not returned before.
  static Dictionary<int, long> handedOut = new Dictionary<int, long>();
  public static Proc[] NewProcesses(string[] names) {
    var want = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
    var seen = new Dictionary<int, long>();
    var list = new List<Proc>();
    foreach (var p in Snapshot()) {
      if (!want.Contains(p.Name)) continue;
      seen[p.Pid] = p.Start;
      long start;
      if (!handedOut.TryGetValue(p.Pid, out start) || start != p.Start) list.Add(p);
    }
    handedOut = seen;
    return list.ToArray();
  }

  // Creation time (FILETIME, UTC) of a running process: with the PID it names the process; -1 if
  // it is not running (or cannot be opened).
  public static long StartTime(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return -1;
    try {
      uint code;
      if (!GetExitCodeProcess(h, out code) || code != 259) return -1;
      long c, e, k, u;
      return GetProcessTimes(h, out c, out e, out k, out u) ? c : -1;
    } finally { CloseHandle(h); }
  }

  // "chrome.exe", lower case; "" if unknown.
  public static string ImageName(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      return QueryFullProcessImageName(h, 0, sb, ref size) ? Path.GetFileName(sb.ToString()).ToLowerInvariant() : "";
    } finally { CloseHandle(h); }
  }

  // The command line of a process (ProcessCommandLineInformation), null if it cannot be read.
  public static string CommandLine(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      int len;
      NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len);
      if (len <= 0 || len > 1 << 20) return null;
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        if (NtQueryInformationProcess(h, 60, buf, len, out len) != 0) return null;
        int bytes = (ushort)Marshal.ReadInt16(buf);   // UNICODE_STRING: Length, MaximumLength, Buffer
        IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size);
        return bytes == 0 || text == IntPtr.Zero ? "" : Marshal.PtrToStringUni(text, bytes / 2);
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { CloseHandle(h); }
  }

  public class Browser { public int Pid; public long Start; public string CommandLine; }

  // The main processes (no --type=) of Chrome/Edge browsers whose command line names this profile
  // directory.
  public static Browser[] BrowserMains(string profile) {
    profile = profile.ToLowerInvariant().Replace('/', '\\');
    var list = new List<Browser>();
    foreach (var p in Processes(new[] { "chrome.exe", "msedge.exe" })) {
      string cl = CommandLine(p.Pid);
      if (cl == null) continue;
      string low = cl.ToLowerInvariant().Replace('/', '\\');
      if (low.Contains("--type=") || !low.Contains(profile)) continue;
      list.Add(new Browser { Pid = p.Pid, Start = p.Start, CommandLine = cl });
    }
    return list.ToArray();
  }

  // The programs that took the most CPU since the last call: "chrome 12 % · kinect-hub 8 %" (share
  // of the whole CPU, all processes of a name together).
  static Dictionary<int, long[]> lastCpu = new Dictionary<int, long[]>();
  static long lastCpuAt;
  public static string TopCpu(int count) {
    long now = DateTime.UtcNow.Ticks;
    double dt = now - lastCpuAt;
    var cur = new Dictionary<int, long[]>();
    var use = new Dictionary<string, double>();
    foreach (var p in Snapshot()) {
      cur[p.Pid] = new long[] { p.Start, p.Cpu };
      long[] old;
      if (lastCpuAt > 0 && dt > 0 && lastCpu.TryGetValue(p.Pid, out old) && old[0] == p.Start && p.Cpu > old[1]) {
        string n = p.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? p.Name.Substring(0, p.Name.Length - 4) : p.Name;
        double was;
        use.TryGetValue(n, out was);
        use[n] = was + (p.Cpu - old[1]) / dt / Environment.ProcessorCount * 100;
      }
    }
    lastCpu = cur;
    lastCpuAt = now;
    var top = new List<KeyValuePair<string, double>>(use);
    top.Sort((a, b) => b.Value.CompareTo(a.Value));
    var sb = new StringBuilder();
    for (int i = 0; i < top.Count && i < count && top[i].Value >= 0.5; i++) {
      if (sb.Length > 0) sb.Append(" \u00b7 ");
      sb.Append(top[i].Key).Append(' ').Append(top[i].Value.ToString("0")).Append(" %");
    }
    return sb.ToString();
  }

  // GET, the body as text; null if it fails or takes longer than ms (no proxy lookup).
  public static string HttpGet(string url, int ms) {
    try {
      var req = (HttpWebRequest)WebRequest.Create(url);
      req.Proxy = null;
      req.Timeout = ms;
      req.ReadWriteTimeout = ms;
      using (var resp = (HttpWebResponse)req.GetResponse())
      using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) return sr.ReadToEnd();
    } catch { return null; }
  }

  // ---- recordings: kinect-hub-probe record writes them (format: kinect-hub/src/recording.rs)

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool GetDiskFreeSpaceEx(string dir, out ulong callerFree, out ulong total, out ulong free);

  // Bytes this user can still write on the drive of dir (an existing folder); -1 if unknown.
  public static long FreeBytes(string dir) {
    ulong callerFree, total, free;
    return GetDiskFreeSpaceEx(dir, out callerFree, out total, out free) ? (long)callerFree : -1;
  }

  public class Recording { public string File; public long Frames; public long Skipped; public double Seconds; public long Bytes; }

  // Reads a .k2rec frame header by frame header: whole frames, frames the hub stream skipped, length.
  // cut: a recording whose recorder was ended (its last frame may be half written) is cut back to
  // its last whole frame. null if the file is no recording; Frames -1 for a format version this
  // does not know (left as it is).
  public static Recording ReadRecording(string path, bool cut) {
    using (var fs = new FileStream(path, FileMode.Open, cut ? FileAccess.ReadWrite : FileAccess.Read, FileShare.Read)) {
      var b = new byte[32];
      if (fs.Read(b, 0, 32) != 32 || BitConverter.ToUInt32(b, 0) != 0x4352324Bu) return null;   // "K2RC"
      if (BitConverter.ToUInt32(b, 4) != 1) return new Recording { File = path, Frames = -1 };
      long pixels = (long)BitConverter.ToUInt16(b, 12) * BitConverter.ToUInt16(b, 14);
      long pos = BitConverter.ToUInt32(b, 8), len = fs.Length;
      if (pos < 32) return null;
      var r = new Recording { File = path };
      ulong first = 0, last = 0;
      uint seq = 0;
      while (pos + 24 <= len) {
        fs.Position = pos;
        if (fs.Read(b, 0, 24) != 24 || BitConverter.ToUInt32(b, 0) != 0x4652324Bu) break;   // "K2RF"
        long payload = BitConverter.ToUInt32(b, 20);
        if (pixels == 0 || (payload != pixels * 2 && payload != pixels * 3) || pos + 24 + payload > len) break;
        uint s = BitConverter.ToUInt32(b, 4);
        ulong t = BitConverter.ToUInt64(b, 8);
        if (r.Frames == 0) first = t;
        else { uint gap = unchecked(s - seq - 1); if (gap < 1000) r.Skipped += gap; }   // a restarted hub counts anew
        last = t;
        seq = s;
        r.Frames++;
        pos += 24 + payload;
      }
      if (cut && pos < len) { fs.SetLength(pos); len = pos; }
      r.Seconds = last > first ? (last - first) / 1e6 : 0;
      r.Bytes = len;
      return r;
    }
  }

  // ---- console: quick edit off (a click into the window would pause this program until a key),
  // and a wait that ends at once when a key is pressed

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint m);

  // Quick edit, mouse and window events off: only keys wake WaitInput.
  public static long NoQuickEdit() {
    IntPtr h = GetStdHandle(-10);
    uint m;
    if (!GetConsoleMode(h, out m)) return -1;
    SetConsoleMode(h, (m & ~0x58u) | 0x80u);
    return m;
  }

  public static void SetInputMode(long m) { if (m >= 0) SetConsoleMode(GetStdHandle(-10), (uint)m); }

  // Sleeps up to ms, ends early when console input arrives ([Console]::KeyAvailable then takes
  // what is not a key out of the queue).
  public static void WaitInput(int ms) {
    IntPtr h = GetStdHandle(-10);
    if (h == IntPtr.Zero || h == new IntPtr(-1) || WaitForSingleObject(h, (uint)ms) == 0xFFFFFFFFu) System.Threading.Thread.Sleep(ms);
  }

  // ---- placing a window on a display, in physical pixels whatever the scaling

  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

  // Moves the largest window of process pid onto the area (x, y, w, h) and maximizes it there;
  // false while the process shows no window yet.
  public static bool PlaceMaximized(int pid, int x, int y, int w, int h) {
    IntPtr old = SetThreadDpiAwarenessContext(new IntPtr(-4));   // per monitor aware v2
    try {
      IntPtr best = IntPtr.Zero;
      long bestArea = 0;
      EnumWindows((hw, l) => {
        uint wp;
        GetWindowThreadProcessId(hw, out wp);
        Rect r;
        if (wp == (uint)pid && IsWindowVisible(hw) && GetWindowRect(hw, out r)) {
          long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
          if (a > bestArea) { bestArea = a; best = hw; }
        }
        return true;
      }, IntPtr.Zero);
      if (best == IntPtr.Zero) return false;
      ShowWindow(best, 9);   // SW_RESTORE
      SetWindowPos(best, IntPtr.Zero, x + 40, y + 40, Math.Max(400, w - 80), Math.Max(300, h - 80), 0x0014);   // NOZORDER | NOACTIVATE
      ShowWindow(best, 3);   // SW_MAXIMIZE
      return true;
    } finally { SetThreadDpiAwarenessContext(old); }
  }
}
'@

New-Item -ItemType Directory -Force $StateDir, $LogDir | Out-Null
if (-not (Test-Path $NoInput)) { [IO.File]::WriteAllText($NoInput, '') }

# The C# part, compiled once per version into the state folder: later starts, the guard and NOTAUS
# only load it (Add-Type with source runs the C# compiler each time, a second or two of CPU).
function Import-Native {
  $sha = New-Object Security.Cryptography.SHA256Managed
  $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($NativeSource))[0..7] | ForEach-Object { $_.ToString('x2') })
  $dll = Join-Path $StateDir "native-$hash.dll"
  if (-not (Test-Path -LiteralPath $dll)) {
    $tmp = Join-Path $StateDir "native-$hash-$PID.dll"
    try {
      Add-Type -TypeDefinition $NativeSource -OutputAssembly $tmp -ErrorAction Stop
      Move-Item -LiteralPath $tmp $dll -ErrorAction Stop   # another process may have been quicker
    } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
  }
  try { Add-Type -Path $dll -ErrorAction Stop } catch { Add-Type -TypeDefinition $NativeSource }
  # older versions go (one still loaded by a running process stays until next time)
  Get-ChildItem -LiteralPath $StateDir -Filter 'native-*.dll' | Where-Object { $_.FullName -ne $dll } |
    Remove-Item -ErrorAction SilentlyContinue
}
Import-Native

# ---------------------------------------------------------------------------------------------
# helpers

function Write-EventLog([string]$text) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}' -f (Get-Date), $PID, $text
  for ($i = 0; $i -lt 5; $i++) {
    try { [IO.File]::AppendAllText($EventLog, $line + "`r`n"); return } catch { Start-Sleep -Milliseconds 50 }
  }
}

# A process is named by its PID and start time (a PID alone may belong to a new process later).
function Get-StartKey([int]$id) {
  $t = [KinectWandNative]::StartTime($id)
  if ($t -lt 0) { return $null }
  return [string]$t
}

# Is it still running, and still the same process? (cheap: no process list)
function Test-Alive($id, $start) {
  if (-not $id) { return $false }
  $t = [KinectWandNative]::StartTime([int]$id)
  if ($t -lt 0) { return $false }
  return (-not $start -or [string]$t -eq [string]$start)
}

function Stop-Tree([int]$id, [switch]$Gentle) {
  $start = Get-StartKey $id
  if (-not $start) { return }
  if ($Gentle) {
    $null = & taskkill.exe /PID $id /T 2>$null
    for ($i = 0; $i -lt 30 -and (Test-Alive $id $start); $i++) { Start-Sleep -Milliseconds 100 }
  }
  if (Test-Alive $id $start) { $null = & taskkill.exe /PID $id /T /F 2>$null }
}

function Read-Json([string]$file) {
  for ($i = 0; $i -lt 5; $i++) {
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try { return (Get-Content -Raw -LiteralPath $file -ErrorAction Stop | ConvertFrom-Json) } catch { Start-Sleep -Milliseconds 40 }
  }
  return $null
}

# Atomic replace, retried while a reader holds the file; throws if it never works.
function Write-Json([string]$file, $obj) {
  $tmp = "$file.$PID.tmp"
  [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
  for ($i = 0; ; $i++) {
    try {
      if (Test-Path -LiteralPath $file) { [IO.File]::Replace($tmp, $file, [NullString]::Value) } else { [IO.File]::Move($tmp, $file) }
      return
    } catch {
      if ($i -ge 20) { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue; throw }
      Start-Sleep -Milliseconds 50
    }
  }
}

function Get-ActiveScheme {
  $out = & powercfg.exe /getactivescheme 2>$null
  if ("$out" -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { return $Matches[1].ToLower() }
  return $null
}

# Does the plan exist? Not from /list: Windows hides some plans there unless they are active
# ("High performance" on this laptop).
function Test-Scheme([string]$guid) {
  if (-not $guid) { return $false }
  $out = & powercfg.exe /query $guid 2>$null
  return ($LASTEXITCODE -eq 0 -and "$out" -match [regex]::Escape($guid))
}

function Get-Schemes {
  # @{ guid = name } of the plans /list shows
  $list = @{}
  foreach ($line in (& powercfg.exe /list 2>$null)) {
    if ($line -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})\s+\((.*)\)') { $list[$Matches[1].ToLower()] = $Matches[2] }
  }
  return $list
}

function Get-MainCheckout {
  $here = Split-Path -Parent $PSCommandPath
  try {
    $first = & git.exe -C $here worktree list --porcelain 2>$null | Select-Object -First 1
    if ($first -match '^worktree (.+)$') { return ($Matches[1] -replace '/', '\') }
  } catch { }
  return $here
}

# ---------------------------------------------------------------------------------------------
# putting things back: used by the main program, the guard and NOTAUS (all without admin rights)

function Restore-Power($j) {
  $problems = @()
  $schemes = Get-Schemes
  $active = Get-ActiveScheme
  $mine = if ($j -and $j.power -and $j.power.temp) { [string]$j.power.temp } else { $null }
  # the plan in this journal, and plans of this program nobody uses (left over); an active one that
  # is not in this journal belongs to another run of this program (a test) and stays
  $temps = @($schemes.Keys | Where-Object { $schemes[$_] -eq $PowerName -and $_ -ne $active })
  if ($mine) { $temps = @($temps + $mine | Select-Object -Unique) }
  if ($active -and $active -eq $mine) {
    $target = $null
    if ($j.power.original) { $target = [string]$j.power.original }
    if (-not $target -or $schemes[$target] -eq $PowerName -or $target -eq $mine -or -not (Test-Scheme $target)) {
      $target = if (Test-Scheme $HighPerf) { $HighPerf } else { $Balanced }
    }
    & powercfg.exe /setactive $target 2>$null | Out-Null
    if ((Get-ActiveScheme) -ne $target) { $problems += "Energieplan $target ließ sich nicht aktivieren" }
  }
  foreach ($t in $temps) {
    if ($t -and (Test-Scheme $t)) {
      & powercfg.exe /delete $t 2>$null | Out-Null
      if (Test-Scheme $t) { $problems += "Energieplan $t ließ sich nicht löschen" }
    }
  }
  Remove-ItemProperty -Path $RunOnceKey -Name $RunOnceName -ErrorAction SilentlyContinue
  return $problems
}

function Restore-Processes($j) {
  foreach ($t in @($j.tuned)) {
    if (-not $t -or -not (Test-Alive $t.pid $t.start)) { continue }
    if ($t.prio) { [void][KinectWandNative]::SetPriority([int]$t.pid, [string]$t.prio) }
    if ($null -ne $t.throttle -and [long]$t.throttle -ge 0) { [void][KinectWandNative]::SetThrottle([int]$t.pid, [long]$t.throttle) }
  }
}

# What the recorder wrote to $out, once it no longer runs. A recording it did not finish itself
# (ended, or the PC went down: still .part) is cut back to its last whole frame and gets its real
# name; if that is less than a second, it is deleted. Returns the numbers of ReadRecording
# (Frames -1: unreadable, left as it is), $null if there is nothing.
function Save-Recording([string]$out) {
  $part = "$out.part"
  $file = if (Test-Path -LiteralPath $part) { $part } elseif (Test-Path -LiteralPath $out) { $out } else { $null }
  if (-not $file) { return $null }
  $isPart = $file -eq $part
  $info = $null
  $read = $false
  for ($i = 0; $i -lt 10 -and -not $read; $i++) {
    # the ended recorder or a virus scanner may still hold the file for a moment
    try { $info = [KinectWandNative]::ReadRecording($file, $isPart); $read = $true } catch { Start-Sleep -Milliseconds 200 }
  }
  # still held, a format version this script does not know, or no recording although the recorder
  # finished it: nothing is touched
  if (-not $read -or ($info -and $info.Frames -lt 0) -or (-not $info -and -not $isPart)) {
    return New-Object 'KinectWandNative+Recording' -Property @{ File = $file; Frames = -1 }
  }
  if ($isPart -and (-not $info -or $info.Frames -lt 30)) {
    Remove-Item -LiteralPath $part -ErrorAction SilentlyContinue
    return $null
  }
  for ($i = 0; $i -lt 10 -and $info.File -eq $part; $i++) {
    try { [IO.File]::Move($part, $out); $info.File = $out } catch { Start-Sleep -Milliseconds 200 }
  }
  return $info
}

# 302.4 s -> "5:02"; 299.97 s (the frames of a 5 minute recording) -> "5:00"
function Format-Time([double]$seconds) {
  $s = [Math]::Max(0, [long][Math]::Round($seconds))
  return '{0}:{1:00}' -f [long][Math]::Floor($s / 60), ($s % 60)
}

# A recording in one line: "wand-2026-10-10-140312.k2rec · 5:00 min · 8990 Bilder · 5,5 GB".
function Format-Recording($info) {
  if (-not $info) { return 'nichts Brauchbares aufgenommen' }
  if ($info.Frames -lt 0) { return "nicht lesbar, liegt unverändert in $($info.File)" }
  $text = '{0} · {1} min · {2} Bilder' -f (Split-Path -Leaf $info.File), (Format-Time $info.Seconds), $info.Frames
  if ($info.Skipped) { $text += " ($($info.Skipped) übersprungen)" }
  return $text + (' · {0:0.0} GB' -f ($info.Bytes / 1GB))
}

function Stop-Started($j) {
  $stopped = @()
  foreach ($role in 'record', 'wall', 'control', 'vite', 'hub') {
    foreach ($s in @($j.started)) {
      if (-not $s -or $s.role -ne $role) { continue }
      if (Test-Alive $s.pid $s.start) {
        Stop-Tree ([int]$s.pid) -Gentle:($role -in 'wall', 'control')
        $stopped += $role
      }
      if ($role -eq 'record' -and $s.out) {
        Write-EventLog "Aufnahme beendet: $(Format-Recording (Save-Recording ([string]$s.out)))"
      }
    }
  }
  return $stopped
}

# Everything back: power plan, priorities, started processes.
function Restore-All($j, [switch]$StopStarted) {
  $problems = @(Restore-Power $j)
  if ($j) { Restore-Processes $j }
  $stopped = @()
  if ($StopStarted -and $j) { $stopped = @(Stop-Started $j) }
  if ($j) {
    $j.active = $false
    try { Write-Json $JournalFile $j } catch { $problems += "Journal: $($_.Exception.Message)" }
  }
  return [pscustomobject]@{ problems = $problems; stopped = $stopped }
}

function Invoke-Notaus([switch]$FromGuard) {
  $j = Read-Json $JournalFile
  if (-not $FromGuard -and $j -and (Test-Alive $j.guardPid $j.guardStart)) { Stop-Process -Id ([int]$j.guardPid) -Force -ErrorAction SilentlyContinue }
  if ($j -and (Test-Alive $j.mainPid $j.mainStart)) { Stop-Process -Id ([int]$j.mainPid) -Force -ErrorAction SilentlyContinue }
  $r = Restore-All $j -StopStarted
  $names = @{ record = 'Aufnahme'; wall = 'Wand-Fenster'; control = 'Steuerzentrale'; vite = 'Dev-Server'; hub = 'Kinect-Hub' }
  $msg = 'NOTAUS: alle Einstellungen sind zurückgestellt'
  if ($r.stopped.Count) { $msg += ', beendet: ' + (($r.stopped | ForEach-Object { $names[$_] }) -join ', ') }
  $msg += '.'
  if ($r.problems.Count) { $msg += "`n`nProbleme:`n" + ($r.problems -join "`n") }
  Write-EventLog ($msg -replace "`n", ' ')
  [KinectWandNative]::Show($msg, [bool]$r.problems.Count)
}

# ---------------------------------------------------------------------------------------------
# mode: NOTAUS (desktop icon, -Panic)

if ($Panic) {
  Invoke-Notaus
  exit 0
}

# ---------------------------------------------------------------------------------------------
# mode: guard (hidden, started by the main program)

if ($Guard) {
  $reason = [KinectWandNative]::Guard($Guard, $GuardStopFlag, $HotkeyFile, [uint32]$HotkeyMods, [uint32]$HotkeyVk)
  Write-EventLog "Wächter: $reason"
  if ($reason -eq 'panic') { Invoke-Notaus -FromGuard; exit 0 }
  if ($reason -eq 'exit') {
    $j = Read-Json $JournalFile
    if ($j -and $j.active -and [int]$j.mainPid -eq $Guard) {
      $r = Restore-All $j -StopStarted
      Write-EventLog ('Programm unerwartet beendet: alles zurückgestellt' + $(if ($r.problems.Count) { '; Probleme: ' + ($r.problems -join '; ') } else { '' }))
    }
  }
  exit 0
}

# =============================================================================================
# main program

$Main = if ($Checkout) { (Resolve-Path $Checkout).Path } else { Get-MainCheckout }
$Web = Join-Path $Main 'web'
$HubExe = Join-Path $Main 'kinect-hub\target\release\kinect-hub.exe'
# where the wall setup lives and the kiosk browser keeps its profile (as tools/wall-window.mjs)
$WallDir = if ($env:KINECT_WALL_DIR) { [IO.Path]::GetFullPath($env:KINECT_WALL_DIR) } else { Join-Path $Web '.cache\wall' }
$WallProfile = (Join-Path (Split-Path -Parent $WallDir) 'wall-browser').ToLower()
$HubUrl = "http://127.0.0.1:$Hub"
$Interactive = -not [Console]::IsInputRedirected
$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$Ps = Join-Path $PSHOME 'powershell.exe'
$Here = Split-Path -Parent $PSCommandPath

$Events = New-Object System.Collections.ArrayList
$script:Drawn = $false
$script:Dirty = $true   # the status screen has something new
function Add-Event([string]$text, [string]$level = 'info') {
  [void]$Events.Add([pscustomobject]@{ t = Get-Date; text = $text; level = $level })
  while ($Events.Count -gt 7) { $Events.RemoveAt(0) }
  Write-EventLog $text
  $script:Dirty = $true
  if (-not $script:Drawn) { Write-Host "  $text" -ForegroundColor $(if ($level -eq 'warn') { 'Yellow' } else { 'Gray' }) }
}

# one program at a time; clean up after a run that did not end properly
$old = Read-Json $JournalFile
if ($old -and $old.active -and (Test-Alive $old.mainPid $old.mainStart)) {
  Write-Host "`n  Die Wand läuft schon (PID $($old.mainPid)). Beenden dort mit Q, Notaus: $HotkeyText.`n" -ForegroundColor Yellow
  if ($Interactive) { [void](Read-Host '  Enter zum Schließen') }
  exit 1
}
$adopt = @()
if ($old -and $old.active) {
  Write-Host '  Der letzte Lauf endete nicht sauber: stelle zurück, was noch übrig ist ...' -ForegroundColor Yellow
  foreach ($s in @($old.started)) {
    if (-not $s) { continue }
    if (Test-Alive $s.pid $s.start) { $adopt += $s }
    elseif ($s.role -eq 'record' -and $s.out) { Write-EventLog "Aufnahme vom letzten Lauf: $(Format-Recording (Save-Recording ([string]$s.out)))" }
  }
  $r = Restore-All $old
  foreach ($p in $r.problems) { Write-Host "  $p" -ForegroundColor Yellow }
}
Remove-Item $GuardStopFlag, $HotkeyFile, $QuitFlag -ErrorAction SilentlyContinue

$J = [pscustomobject]@{
  version    = 1
  active     = $true
  mainPid    = $PID
  mainStart  = Get-StartKey $PID
  script     = $PSCommandPath
  guardPid   = 0
  guardStart = $null
  power      = [pscustomobject]@{ original = $null; temp = $null }
  started    = @($adopt)
  tuned      = @()
}
function Save-Journal { try { Write-Json $JournalFile $J; return $true } catch { Add-Event "Journal: $($_.Exception.Message)" 'warn'; return $false } }
if (-not (Save-Journal)) {
  Write-Host "`n  Das Journal ($JournalFile) lässt sich nicht schreiben: ohne Journal ändert das Skript nichts.`n" -ForegroundColor Red
  if ($Interactive) { [void](Read-Host '  Enter zum Schließen') }
  exit 1
}

try { $Host.UI.RawUI.WindowTitle = "Kinect-Wand  (Q beenden, Notaus $HotkeyText)" } catch { }
Write-Host "`n  Kinect-Wand startet  ($Main)`n" -ForegroundColor Cyan

# ---- desktop icons: start and NOTAUS
function Set-Shortcut([string]$name, [string]$target, [string]$arguments, [string]$icon) {
  try {
    $file = Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($file)
    if ($lnk.TargetPath -eq $target -and $lnk.Arguments -eq $arguments) { return }
    $lnk.TargetPath = $target
    $lnk.Arguments = $arguments
    $lnk.WorkingDirectory = $LinkDir
    if ($icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
    Add-Event "Desktop-Symbol '$name' angelegt"
  } catch { Add-Event "Desktop-Symbol ${name}: $($_.Exception.Message)" 'warn' }
}
# the icons use the main checkout's copy once it has one (a worktree may go away)
$LinkDir = if (Test-Path (Join-Path $Main 'start-wand.ps1')) { $Main } else { $Here }
Set-Shortcut 'Kinect-Wand NOTAUS' $Ps "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $LinkDir 'start-wand.ps1')`" -Panic" "$env:SystemRoot\System32\shell32.dll,27"
Set-Shortcut 'Kinect-Wand starten' (Join-Path $LinkDir 'start-wand.cmd') '' "$env:SystemRoot\System32\imageres.dll,186"
Set-Shortcut 'Kinect-Wand starten (minimal)' (Join-Path $LinkDir 'start-wand.cmd') '-Minimal' "$env:SystemRoot\System32\imageres.dll,186"

# ---- the guard: puts everything back when this window closes or crashes; NOTAUS hotkey
$script:HotkeyBusy = $null
function Start-Guard {
  $g = Start-Process -FilePath $Ps -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Guard', $PID)
  $J.guardPid = $g.Id
  $J.guardStart = Get-StartKey $g.Id
  $script:HotkeyBusy = $null
  [void](Save-Journal)
}
Start-Guard

# ---- power plan (write-ahead: the journal and RunOnce know the way back before anything changes)
function Enable-PowerPlan {
  $orig = Get-ActiveScheme
  $schemes = Get-Schemes
  if (-not $orig -or $schemes[$orig] -eq $PowerName) { Add-Event 'Energieplan: aktiver Plan unklar, bleibt, wie er ist' 'warn'; return }
  $J.power.original = $orig
  if (-not (Save-Journal)) { return }
  # -Minimal: Windows' own "Balanced" (the CPU clocks as Windows and the chip decide), else "High performance"
  $base = if ($Minimal) { if (Test-Scheme $Balanced) { $Balanced } else { $orig } } elseif (Test-Scheme $HighPerf) { $HighPerf } else { $orig }
  $out = & powercfg.exe /duplicatescheme $base 2>$null
  if ("$out" -notmatch '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { Add-Event 'Energieplan: Kopie fehlgeschlagen' 'warn'; return }
  $temp = $Matches[1].ToLower()
  $J.power.temp = $temp
  if (-not (Save-Journal)) { & powercfg.exe /delete $temp 2>$null | Out-Null; $J.power.temp = $null; return }
  & powercfg.exe /changename $temp $PowerName 'Voruebergehend von start-wand.ps1, wird beim Beenden geloescht' 2>$null | Out-Null
  $failed = 0
  foreach ($s in $PowerSettings) {
    if ($Minimal -and -not $s[4]) { continue }
    if ($null -ne $s[2]) { & powercfg.exe /setacvalueindex $temp $s[0] $s[1] $s[2] 2>$null | Out-Null; if ($LASTEXITCODE) { $failed++ } }
    if ($null -ne $s[3]) { & powercfg.exe /setdcvalueindex $temp $s[0] $s[1] $s[3] 2>$null | Out-Null; if ($LASTEXITCODE) { $failed++ } }
  }
  New-ItemProperty -Path $RunOnceKey -Name $RunOnceName -PropertyType String -Force `
    -Value "cmd.exe /c powercfg /setactive $orig & powercfg /delete $temp" | Out-Null
  & powercfg.exe /setactive $temp 2>$null | Out-Null
  if ((Get-ActiveScheme) -eq $temp) {
    Add-Event ("Energieplan '$PowerName' aktiv" + $(if ($Minimal) { ' (minimal: nur kein Standby, Deckel, USB; die CPU regelt Windows)' }) +
      $(if ($failed) { " ($failed Werte gibt es auf diesem Rechner nicht)" } else { '' }))
  } else {
    Add-Event 'Energieplan ließ sich nicht aktivieren' 'warn'
  }
}
Enable-PowerPlan
[KinectWandNative]::KeepAwake($true)
$script:Optimize = $true

# ---- priorities and efficiency mode
$TuneNames = @('kinect-hub.exe', 'fn2_capture.exe', 'chrome.exe', 'msedge.exe', 'node.exe', 'msedgewebview2.exe') +
  @($BackgroundApps | ForEach-Object { "$_.exe" })
$BackgroundExes = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($a in $BackgroundApps) { [void]$BackgroundExes.Add("$a.exe") }
$script:TuneSummary = ''

function Get-Role([string]$name, [int]$id) {
  switch ($name.ToLower()) {
    'kinect-hub.exe' {
      $port = 8090
      if ([string][KinectWandNative]::CommandLine($id) -match '--bind\s+"?[^\s"]*:(\d+)') { $port = [int]$Matches[1] }
      if ($port -eq $Hub) { return 'core' }
      return 'background'   # test hubs (replay, synthetic)
    }
    'fn2_capture.exe' { return 'core' }
    { $_ -in 'chrome.exe', 'msedge.exe' } {
      $cl = [string][KinectWandNative]::CommandLine($id)
      if ($cl.ToLower().Replace('/', '\').Contains($WallProfile)) {
        if ($cl -notmatch '--type=' -or $cl -match '--type=(gpu-process|renderer)') { return 'wall' }
        return $null
      }
      if ($cl -match '--headless') { return 'background' }   # test runs (npm run check)
      return $null
    }
    'node.exe' {
      $cl = [string][KinectWandNative]::CommandLine($id)
      if ($cl -match 'vite' -and -not $cl.ToLower().Contains($Web.ToLower() + '\')) { return 'background' }   # other worktrees
      return $null
    }
    'msedgewebview2.exe' {
      if ([string][KinectWandNative]::CommandLine($id) -match '--webview-exe-name=([^\s"]+?)\.exe' -and $BackgroundApps -contains $Matches[1]) { return 'background' }
      return $null
    }
  }
  if ($BackgroundExes.Contains($name)) { return 'background' }
  return $null
}

function Update-TuneSummary {
  $core = 0; $wall = 0
  $bg = New-Object 'System.Collections.Generic.SortedSet[string]'
  foreach ($t in @($J.tuned)) {
    if (-not $t) { continue }
    if ($t.role -eq 'core') { $core++ } elseif ($t.role -eq 'wall') { $wall++ } else { [void]$bg.Add([string]$t.name) }
  }
  $script:TuneSummary = "Vorrang: Hub/Worker ($core), Wand-Browser ($wall) · Effizienzmodus: $(if ($bg.Count) { @($bg) -join ', ' } else { '-' })"
  $script:Dirty = $true
}

# Each process is looked at once, when it is new (the native side remembers which ones it handed out).
function Update-Tuning {
  $new = @()
  foreach ($p in [KinectWandNative]::NewProcesses([string[]]$TuneNames)) {
    $role = Get-Role $p.Name $p.Pid
    if (-not $role) { continue }
    $prio = [KinectWandNative]::GetPriority($p.Pid)
    if (-not $prio) { continue }
    $want = if ($role -eq 'background') { 'Idle' } else { 'AboveNormal' }
    $new += [pscustomobject]@{
      pid = $p.Pid; start = [string]$p.Start; name = ($p.Name -replace '\.exe$', ''); role = $role
      prio = $prio; throttle = [KinectWandNative]::GetThrottle($p.Pid)
      want = $want; eco = ($role -eq 'background')
    }
  }
  if (-not $new.Count) { return }
  $J.tuned = @($J.tuned | Where-Object { $_ -and (Test-Alive $_.pid $_.start) }) + @($new | Select-Object pid, start, name, role, prio, throttle)
  if (-not (Save-Journal)) { return }   # write-ahead: the old values are on disk before anything changes
  foreach ($n in $new) {
    [void][KinectWandNative]::SetPriority($n.pid, $n.want)
    [void][KinectWandNative]::SetEco($n.pid, $n.eco)
  }
  Update-TuneSummary
}

# ---- components: hub, dev server, output window
$script:HubStatus = $null
$script:HubFails = 0
$script:HubOurs = $null
$script:ViteOurs = $null
$script:Vite = $null        # dev-server.json of the main checkout while it answers
$script:WallPid = 0
$script:WallStart = $null
$script:WallUrl = $null
$script:WallAuto = -not $NoWall
$script:WallLaunches = New-Object System.Collections.ArrayList
$script:NextTry = @{ hub = 0; vite = 0; wall = 0; hubPoll = 0 }
$script:ControlPid = 0
$script:ControlStart = $null
$script:ControlUrl = $null
$script:Rec = $null         # the running recording (its journal entry)
$Clock = [Diagnostics.Stopwatch]::StartNew()
# how often the loop looks at things, in seconds (-Minimal: less often)
$PlaceEvery = if ($Minimal) { 2 } else { 0.5 }   # where our wall window is
$ScanEvery = if ($Minimal) { 10 } else { 2 }     # all windows (a wall browser opened elsewhere)
$HubEvery = if ($Minimal) { 30 } else { 10 }     # the hub's status, while it answers
$DrawEvery = if ($Minimal) { 30 } else { 10 }    # the status screen
if ($Minimal) { [KinectWandNative]::ScreensEachMinute = $false }
foreach ($s in $adopt) {
  if ($s.role -eq 'hub') { $script:HubOurs = $s }
  if ($s.role -eq 'vite') { $script:ViteOurs = $s }
  if ($s.role -eq 'wall') { $script:WallPid = [int]$s.pid; $script:WallStart = $s.start }
  if ($s.role -eq 'control') { $script:ControlPid = [int]$s.pid; $script:ControlStart = $s.start }
  if ($s.role -eq 'record') { $script:Rec = $s }
}

function Add-Started([string]$role, [int]$id) {
  $entry = [pscustomobject]@{ role = $role; pid = $id; start = (Get-StartKey $id) }
  $J.started = @($J.started | Where-Object { $_ -and $_.role -ne $role }) + $entry
  [void](Save-Journal)
  return $entry
}

function Test-Ours($entry) { return [bool]($entry -and (Test-Alive $entry.pid $entry.start)) }

function Get-HubStatus {
  $text = [KinectWandNative]::HttpGet("$HubUrl/api/status", 2000)
  if (-not $text) { return $null }
  try { return ConvertFrom-Json $text } catch { return $null }
}

function Test-Listening([int]$port) {
  foreach ($l in [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
    if ($l.Port -eq $port) { return $true }
  }
  return $false
}

function Start-Hub {
  if ($Hub -ne 8090) { Add-Event "Hub :$Hub antwortet nicht (gestartet wird nur der echte Hub auf 8090)" 'warn'; return }
  if (-not (Test-Path $HubExe)) { Add-Event "kinect-hub.exe fehlt: $HubExe (im main bauen)" 'warn'; return }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $p = Start-Process -FilePath $HubExe -WorkingDirectory $Main -WindowStyle Hidden -PassThru -RedirectStandardInput $NoInput `
    -RedirectStandardOutput (Join-Path $LogDir "hub-$stamp.out.log") -RedirectStandardError (Join-Path $LogDir "hub-$stamp.log")
  $script:HubOurs = Add-Started 'hub' $p.Id
  Add-Event "Kinect-Hub gestartet (PID $($p.Id))"
}

function Get-DevServer {
  $info = Read-Json (Join-Path $Web '.cache\dev-server.json')
  if (-not $info -or -not $info.url -or -not $info.pid) { return $null }
  if (-not (Test-Alive $info.pid $null)) { return $null }
  if ($null -eq [KinectWandNative]::HttpGet("$($info.url)/__scenes", 3000)) { return $null }
  return $info
}

function Start-Vite {
  if (-not $Node) { Add-Event 'node.exe nicht gefunden: der Dev-Server kann nicht starten' 'warn'; return }
  $vite = Join-Path $Web 'node_modules\vite\bin\vite.js'
  if (-not (Test-Path $vite)) { Add-Event "Dev-Server: $vite fehlt (npm install in web)" 'warn'; return }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $before = $env:KINECT_HUB
  $env:KINECT_HUB = $HubUrl
  try {
    $p = Start-Process -FilePath $Node -ArgumentList "`"$vite`"" -WorkingDirectory $Web -WindowStyle Hidden -PassThru -RedirectStandardInput $NoInput `
      -RedirectStandardOutput (Join-Path $LogDir "vite-$stamp.log") -RedirectStandardError (Join-Path $LogDir "vite-$stamp.err.log")
  } finally { $env:KINECT_HUB = $before }
  $script:ViteOurs = Add-Started 'vite' $p.Id
  for ($i = 0; $i -lt 60 -and -not $p.HasExited; $i++) {
    Start-Sleep -Milliseconds 500
    $info = Get-DevServer
    if ($info -and [int]$info.pid -eq $p.Id) { $script:Vite = $info; break }
  }
  if ($script:Vite -and [int]$script:Vite.pid -eq $p.Id) { Add-Event "Dev-Server gestartet: $($script:Vite.url)" }
  else { Add-Event "Dev-Server startet nicht (Logs: L)" 'warn' }
}

# The main process of an output window (its own browser profile), or $null.
function Find-Wall { return [KinectWandNative]::BrowserMains($WallProfile) | Select-Object -First 1 }

# The display for the output window, found automatically every time: the second display, never the
# notebook's own panel. Only with several other displays does the monitor name in the wall setup
# pick one (else the leftmost); $null while only the notebook's panel is there.
function Get-WallScreen {
  $all = @([KinectWandNative]::Screens())
  $inner = @($all | Where-Object { $_.Internal } | ForEach-Object { $_.Device })
  # a display that duplicates the notebook's panel shares its desktop: the window would be on both
  $script:ScreenMirrored = [bool]@($all | Where-Object { -not $_.Internal -and $inner -contains $_.Device }).Count
  $ext = @($all | Where-Object { -not $_.Internal -and $_.Width -gt 0 -and $inner -notcontains $_.Device } | Sort-Object X, Y)
  if ($ext.Count -le 1) { return ($ext | Select-Object -First 1) }
  $setup = Read-Json (Join-Path $WallDir 'setup.json')
  $label = if ($setup -and $setup.output -and $setup.output.window) { [string]$setup.output.window.label } else { '' }
  if ($label) {
    $hit = $ext | Where-Object { $_.Name -eq $label } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  return $ext[0]
}

# The notebook's own panel, $null while it is off (lid closed).
function Get-NotebookScreen {
  return [KinectWandNative]::Screens() | Where-Object { $_.Internal -and $_.Width -gt 0 } | Select-Object -First 1
}

function Get-BrowserExe {
  $list = @($env:CHROME_PATH, "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  return $list | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

# ---- the control center: an app window of its own (own browser profile), maximized on the
# notebook's panel; never opened while that panel is off, so it never covers the wall
$ControlProfile = Join-Path (Split-Path -Parent $WallDir) 'control-browser'

# No "translate this page?" bubble in the control center: its profile gets German as the browser's
# language and translation switched off (Preferences, written while that browser is closed).
function Set-NoTranslate([string]$profileDir) {
  try {
    $file = Join-Path $profileDir 'Default\Preferences'
    New-Item -ItemType Directory -Force (Split-Path -Parent $file) | Out-Null
    Add-Type -AssemblyName System.Web.Extensions
    $js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $js.MaxJsonLength = [int]::MaxValue
    $prefs = $null
    if (Test-Path -LiteralPath $file) { $prefs = $js.DeserializeObject([IO.File]::ReadAllText($file)) }
    if ($prefs -isnot [System.Collections.Generic.Dictionary[string, object]]) { $prefs = New-Object 'System.Collections.Generic.Dictionary[string, object]' }
    $translate = New-Object 'System.Collections.Generic.Dictionary[string, object]'
    $translate['enabled'] = $false
    $prefs['translate'] = $translate.PSObject.BaseObject   # unwrapped: the serializer chokes on PowerShell's wrapper
    $intl = $prefs['intl']
    if ($intl -isnot [System.Collections.Generic.Dictionary[string, object]]) { $intl = New-Object 'System.Collections.Generic.Dictionary[string, object]' }
    $intl['accept_languages'] = 'de-DE,de'
    $intl['selected_languages'] = 'de-DE,de'
    $prefs['intl'] = $intl.PSObject.BaseObject
    [IO.File]::WriteAllText($file, $js.Serialize($prefs.PSObject.BaseObject), (New-Object Text.UTF8Encoding $false))
  } catch {
    Add-Event "Steuerzentrale: Übersetzen ließ sich nicht abschalten ($($_.Exception.Message))" 'warn'
  }
}

function Open-Control {
  if (-not $script:Vite) { Add-Event 'Steuerzentrale: der Dev-Server läuft noch nicht' 'warn'; return }
  $nb = Get-NotebookScreen
  if (-not $nb) { Add-Event 'Der Notebook-Bildschirm ist aus (Deckel zu?): die Steuerzentrale bleibt zu, S öffnet sie' 'warn'; return }
  $url = "$($script:Vite.url)/control/"
  if (Test-Alive $script:ControlPid $script:ControlStart) {
    # already open: S brings it back onto the notebook's panel
    [void][KinectWandNative]::PlaceMaximized($script:ControlPid, $nb.X, $nb.Y, $nb.Width, $nb.Height)
    return
  }
  $exe = Get-BrowserExe
  if (-not $exe) { Add-Event 'Kein Chrome/Edge gefunden: die Steuerzentrale bleibt zu' 'warn'; return }
  # a window of this profile from before (one browser per profile): reuse it if it shows this dev server
  foreach ($b in [KinectWandNative]::BrowserMains($ControlProfile)) {
    if ($b.CommandLine.Contains("--app=$url")) {
      $script:ControlPid = $b.Pid; $script:ControlStart = [string]$b.Start; $script:ControlUrl = $script:Vite.url
      [void][KinectWandNative]::PlaceMaximized($script:ControlPid, $nb.X, $nb.Y, $nb.Width, $nb.Height)
      Add-Event 'Steuerzentrale ist schon offen, auf den Notebook-Bildschirm geholt'
      return
    }
    Stop-Tree $b.Pid -Gentle
  }
  Set-NoTranslate $ControlProfile
  $browserArgs = @("--user-data-dir=`"$ControlProfile`"", '--no-first-run', '--no-default-browser-check', '--lang=de',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--disable-features=Translate',
    "--window-position=$($nb.X + 40),$($nb.Y + 40)", '--start-maximized', "--app=$url")
  $p = Start-Process -FilePath $exe -ArgumentList $browserArgs -PassThru
  $e = Add-Started 'control' $p.Id
  $script:ControlPid = $p.Id
  $script:ControlStart = $e.start
  $script:ControlUrl = $script:Vite.url
  for ($i = 0; $i -lt 50 -and (Test-Alive $p.Id $e.start); $i++) {
    if ([KinectWandNative]::PlaceMaximized($p.Id, $nb.X, $nb.Y, $nb.Width, $nb.Height)) { break }
    Start-Sleep -Milliseconds 100
  }
  Add-Event 'Steuerzentrale geöffnet auf dem Notebook-Bildschirm'
}

function Format-Screen($d) {
  if (-not $d) { return '?' }
  $name = if ($d.Internal) { 'Notebook' } elseif ($d.Name) { $d.Name } else { $d.Device }
  return '{0} ({1}×{2} bei {3},{4})' -f $name, $d.Width, $d.Height, $d.X, $d.Y
}

$script:ScreenMissing = ''   # '' / 'none' / 'mirror': why the output window cannot open
$script:ScreenMirrored = $false
$script:WallScreen = $null

# The display the output window may open on, with a message once when there is none.
function Get-OpenScreen {
  $screen = Get-WallScreen
  if (-not $screen) {
    $why = if ($script:ScreenMirrored) { 'mirror' } else { 'none' }
    if ($script:ScreenMissing -ne $why) {
      if ($why -eq 'mirror') { Add-Event 'Der zweite Bildschirm zeigt dasselbe wie das Notebook: mit Win+P auf "Erweitern" stellen, dann geht das Wand-Fenster dort auf' 'warn' }
      else { Add-Event 'Kein zweiter Bildschirm: das Wand-Fenster bleibt zu, bis einer angeschlossen ist' 'warn' }
    }
    $script:ScreenMissing = $why
    return $null
  }
  if ($script:ScreenMissing) { Add-Event "Zweiter Bildschirm da: $(Format-Screen $screen)" }
  $script:ScreenMissing = ''
  return $screen
}

function Open-Wall($screen) {
  if (-not $script:Vite -or -not $Node) { return }
  $now = $Clock.Elapsed.TotalSeconds
  while ($script:WallLaunches.Count -and $script:WallLaunches[0] -lt $now - 180) { $script:WallLaunches.RemoveAt(0) }
  if ($script:WallLaunches.Count -ge 4) {
    $script:WallAuto = $false
    Add-Event 'Das Wand-Fenster geht immer wieder zu: automatisches Öffnen aus (W öffnet es)' 'warn'
    return
  }
  [void]$script:WallLaunches.Add($now)
  $url = $script:Vite.url
  $place = '{0},{1},{2},{3}' -f $screen.X, $screen.Y, $screen.Width, $screen.Height
  $out = & $Node (Join-Path $Web 'tools\wall-window.mjs') --url $url --screen $place 2>&1 | Out-String
  if ($out -match 'PID (\d+)' -and (Test-Alive ([int]$Matches[1]) $null)) {
    $id = [int]$Matches[1]
    $e = Add-Started 'wall' $id
    $script:WallPid = $id
    $script:WallStart = $e.start
    $script:WallUrl = $url
    $script:WallScreen = $screen
    # check at once where it really opened (closed within a fraction of a second if on the notebook)
    for ($i = 0; $i -lt 50 -and (Test-Alive $id $e.start); $i++) {
      if (-not (Test-WallPlace)) { return }
      if ([KinectWandNative]::WindowDisplay($id)) { break }
      Start-Sleep -Milliseconds 100
    }
    Add-Event "Wand-Fenster geöffnet auf $(Format-Screen $screen)"
    return
  }
  Add-Event ('Wand-Fenster: ' + (($out -split "`n" | Where-Object { $_.Trim() }) -join ' ').Trim()) 'warn'
}

function Close-Wall([switch]$Now) {
  if ($script:WallPid) { Stop-Tree $script:WallPid -Gentle:(-not $Now) }
  $script:WallPid = 0
  $script:WallStart = $null
}

# No wall window may be on the notebook's own panel (wrong place at launch, opened there from the
# control center, or moved there by Windows when the LED screen went away): it gets WM_CLOSE at
# once, its browser is ended if it is still there 1.5 s later; ours opens again on a second display
# as soon as there is one. Returns $false if ours was on the notebook. $bad: a WallScan just made.
$script:InternalSince = @{}
$script:WallPlaceVer = -1
function Test-WallPlace($bad = $null) {
  if ($null -eq $bad) { $bad = [KinectWandNative]::WallScan([int]$script:WallPid, $WallProfile, $true) }
  if ($bad.Length -eq 0) {
    if ($script:InternalSince.Count) { $script:InternalSince.Clear() }
  } else {
    $now = $Clock.Elapsed.TotalSeconds
    foreach ($id in $bad) {
      if (-not $script:InternalSince.ContainsKey($id)) {
        $script:InternalSince[$id] = $now
        Add-Event 'Ein Wand-Fenster war auf dem Notebook-Bildschirm: sofort geschlossen' 'warn'
      } elseif ($now - $script:InternalSince[$id] -gt 1.5) {
        Stop-Tree $id
        Add-Event 'Das Wand-Fenster ging auf dem Notebook nicht zu: Browser beendet' 'warn'
      }
    }
    foreach ($k in @($script:InternalSince.Keys)) { if ($bad -notcontains $k) { $script:InternalSince.Remove($k) } }
    if ($script:WallPid -and $bad -contains $script:WallPid) {
      $script:NextTry.wall = $now + 3
      return $false
    }
  }
  # where ours is (for the status screen): looked up only when that or the displays changed
  if ($script:WallPlaceVer -ne [KinectWandNative]::PlaceVersion) {
    $script:WallPlaceVer = [KinectWandNative]::PlaceVersion
    $dev = [KinectWandNative]::OurDevice
    if ($script:WallPid -and $dev) {
      $place = [KinectWandNative]::Screens() | Where-Object { $_.Device -eq $dev } | Select-Object -First 1
      if ($place -and -not $place.Internal) { $script:WallScreen = $place; $script:Dirty = $true }
    }
  }
  return $true
}

function Watch-Components {
  $now = $Clock.Elapsed.TotalSeconds
  # hub: asked every 10 s (minimal: 30 s) while it answers (for the screen), every 2 s while it does not
  if ($now -ge $script:NextTry.hubPoll) {
    $was = [bool]$script:HubStatus
    $script:HubStatus = Get-HubStatus
    if ($script:HubStatus) { $script:HubFails = 0 } else { $script:HubFails++ }
    if ([bool]$script:HubStatus -ne $was) { $script:Dirty = $true }
    $script:NextTry.hubPoll = $now + $(if ($script:HubStatus) { $HubEvery } else { 2 })
    if (-not $script:HubStatus -and $script:HubFails -ge 3 -and $now -ge $script:NextTry.hub) {
      if (Test-Ours $script:HubOurs) {
        Add-Event 'Kinect-Hub antwortet nicht' 'warn'
      } elseif (-not (Test-Listening $Hub)) {
        Start-Hub
      } else {
        Add-Event "Port $Hub ist belegt, aber kein Hub antwortet" 'warn'
      }
      $script:NextTry.hub = $now + 15
    }
  }
  # dev server
  if (-not $script:Vite -or -not (Test-Alive $script:Vite.pid $null)) {
    $script:Vite = Get-DevServer
    if (-not $script:Vite -and $now -ge $script:NextTry.vite) {
      Add-Event 'Der Dev-Server läuft nicht: starte ihn' 'warn'
      Start-Vite
      $script:NextTry.vite = $Clock.Elapsed.TotalSeconds + 20
    }
  }
  # output window
  if ($script:WallPid -and -not (Test-Alive $script:WallPid $script:WallStart)) {
    $script:WallPid = 0
    if ($script:WallAuto) { Add-Event 'Das Wand-Fenster wurde geschlossen: öffne es wieder' 'warn'; $script:NextTry.wall = $now + 3 }
  }
  # control center: closed by hand stays closed (S); a new dev server address needs a new window
  if ($script:ControlPid -and -not (Test-Alive $script:ControlPid $script:ControlStart)) {
    $script:ControlPid = 0
    Add-Event 'Steuerzentrale geschlossen (S öffnet sie wieder)'
  }
  if ($script:ControlPid -and $script:Vite -and $script:ControlUrl -and $script:ControlUrl -ne $script:Vite.url) {
    Stop-Tree $script:ControlPid -Gentle
    $script:ControlPid = 0
    Open-Control
  }
  if ($script:WallPid -and $script:Vite -and $script:WallUrl -and $script:WallUrl -ne $script:Vite.url) {
    Add-Event "Der Dev-Server hat eine neue Adresse: öffne das Wand-Fenster neu"
    Close-Wall
    $script:NextTry.wall = 0
  }
  if ($script:WallAuto -and -not $script:WallPid -and $script:Vite -and $now -ge $script:NextTry.wall) {
    $script:NextTry.wall = $now + 5
    $screen = Get-OpenScreen
    if (-not $screen) { return }
    $found = Find-Wall
    if ($found -and $found.CommandLine.Contains("--app=$($script:Vite.url)/wall/")) {
      $script:WallPid = $found.Pid; $script:WallStart = [string]$found.Start; $script:WallUrl = $script:Vite.url
      if (-not ($J.started | Where-Object { $_ -and $_.role -eq 'wall' -and [int]$_.pid -eq $found.Pid })) { Add-Event "Das Wand-Fenster ist schon offen (PID $($found.Pid)), wird mitbenutzt" }
      [void](Test-WallPlace)
    } else {
      if ($found) { Stop-Tree $found.Pid -Gentle }   # an old window of another dev server
      Open-Wall $screen
    }
  }
}

# ---- recordings for training data (R): kinect-hub-probe record reads depth and infrared from the
# running hub (never the sensor) in a hidden process of its own. It has no window to close, so it
# is ended hard when it has to stop early; Save-Recording keeps what it wrote.
$RecordDir = Join-Path $Main 'recordings'
$RecordSize = $RecordMinutes * 60 * $RecordRate

function Get-ProbeExe {
  $exe = Join-Path $Main 'kinect-hub\target\release\kinect-hub-probe.exe'
  # a test checkout (-Checkout) has no build of its own
  if (-not (Test-Path -LiteralPath $exe) -and $Checkout) { $exe = Join-Path (Get-MainCheckout) 'kinect-hub\target\release\kinect-hub-probe.exe' }
  if (Test-Path -LiteralPath $exe) { return $exe }
  return $null
}

# Free bytes where the recordings go (the checkout's drive while that folder does not exist yet).
function Get-RecordFree {
  return [KinectWandNative]::FreeBytes($(if ([IO.Directory]::Exists($RecordDir)) { $RecordDir } else { $Main }))
}

function Test-Recording { return [bool]($script:Rec -and $script:Rec.start -and (Test-Alive $script:Rec.pid $script:Rec.start)) }

# Why no recording can start now; '' if one can.
function Get-RecordBlocker {
  if ($script:Rec) { return 'Es läuft schon eine Aufnahme' }
  if (-not (Get-ProbeExe)) { return 'Aufnahme: kinect-hub-probe.exe fehlt (im main bauen: cargo build --release in kinect-hub)' }
  $h = Get-HubStatus
  if (-not $h) { return "Aufnahme: der Hub $HubUrl antwortet nicht" }
  if ([string]$h.sensor.state -ne 'streaming') { return "Aufnahme: die Kinect liefert gerade keine Bilder (Sensor $($h.sensor.state))" }
  $free = Get-RecordFree
  if ($free -ge 0 -and $free -lt $RecordSize + $RecordReserve) {
    return 'Aufnahme: zu wenig Platz, {0:0.0} GB frei; {1} min brauchen etwa {2:0.0} GB, und {3:0} GB sollen frei bleiben' -f ($free / 1GB), $RecordMinutes, ($RecordSize / 1GB), ($RecordReserve / 1GB)
  }
  return ''
}

function Start-Recording {
  $why = Get-RecordBlocker
  if ($why) { Add-Event $why 'warn'; return }
  $now = Get-Date
  $out = Join-Path $RecordDir ('wand-{0:yyyy-MM-dd-HHmmss}.k2rec' -f $now)
  $log = Join-Path $LogDir ('record-{0:yyyyMMdd-HHmmss}' -f $now)
  $seconds = $RecordMinutes * 60
  try {
    $p = Start-Process -FilePath (Get-ProbeExe) -WorkingDirectory $Main -WindowStyle Hidden -PassThru -ErrorAction Stop `
      -ArgumentList @('record', '--seconds', $seconds, '--url', "ws://127.0.0.1:$Hub/ws", '--out', "`"$out`"") `
      -RedirectStandardInput $NoInput -RedirectStandardOutput "$log.log" -RedirectStandardError "$log.err.log"
  } catch { Add-Event "Aufnahme startet nicht: $($_.Exception.Message)" 'warn'; return }
  # below the show (hub, worker, wall browser: above normal); a frame it is too slow for is skipped
  # by the hub, nothing waits for it
  [void][KinectWandNative]::SetPriority($p.Id, 'BelowNormal')
  $script:Rec = [pscustomobject]@{ role = 'record'; pid = $p.Id; start = (Get-StartKey $p.Id); out = $out; log = $log; seconds = $seconds }
  # one that ended at once has nothing to stop (and its PID may belong to another process soon)
  if ($script:Rec.start) {
    $J.started = @($J.started | Where-Object { $_ -and $_.role -ne 'record' }) + $script:Rec
    [void](Save-Journal)
  }
  Add-Event ('Aufnahme läuft: {0} ({1} min, etwa {2:0.0} GB)' -f (Split-Path -Leaf $out), $RecordMinutes, ($RecordSize / 1GB))
}

# The first group of the last line in a log that matches pattern; '' if none.
function Get-LogMatch([string]$file, [string]$pattern) {
  $hit = ''
  try { foreach ($line in [IO.File]::ReadAllLines($file)) { if ($line -match $pattern) { $hit = $Matches[1] } } } catch { }
  return $hit
}

# The recorder has ended (finished, failed or stopped): keep what it wrote and say so.
function Complete-Recording([switch]$Stopped) {
  $r = $script:Rec
  $info = Save-Recording ([string]$r.out)
  $script:Rec = $null
  $J.started = @($J.started | Where-Object { $_ -and $_.role -ne 'record' })
  [void](Save-Journal)
  if ($script:ConfirmKind -eq 'stoprec') { $script:ConfirmUntil = 0 }
  if ($Stopped) { Add-Event "Aufnahme beendet: $(Format-Recording $info)"; return }
  if (-not $info) {
    $why = Get-LogMatch "$($r.log).err.log" 'record failed: (.+)'
    Add-Event ('Aufnahme fehlgeschlagen: ' + $(if ($why) { $why } else { 'nichts Brauchbares aufgenommen (Logs: L)' })) 'warn'
  } elseif ($info.Frames -lt 0) {
    Add-Event "Aufnahme: $(Format-Recording $info)" 'warn'
  } elseif ($info.Seconds -ge [double]$r.seconds - 2) {
    Add-Event "Aufnahme fertig: $(Format-Recording $info)"
  } else {
    # the recorder's own reason, e.g. "connection lost: ..." when the hub restarted
    $why = Get-LogMatch "$($r.log).log" ' MB \((.+)\)\s*$'
    Add-Event ("Aufnahme vorzeitig zu Ende: $(Format-Recording $info)" + $(if ($why) { " ($why)" })) 'warn'
  }
}

# Ends the running recording now: keeps what it has, or deletes it.
function Stop-Recording([switch]$Delete) {
  $r = $script:Rec
  if (-not $r) { return }
  if (Test-Recording) { Stop-Tree ([int]$r.pid) }
  if (-not $Delete) { Complete-Recording -Stopped; return }
  $files = @("$($r.out).part", [string]$r.out)
  for ($i = 0; $i -lt 10 -and @($files | Where-Object { Test-Path -LiteralPath $_ }).Count; $i++) {
    if ($i) { Start-Sleep -Milliseconds 200 }   # the ended recorder may still hold the file for a moment
    Remove-Item -LiteralPath $files -Force -ErrorAction SilentlyContinue
  }
  $left = @($files | Where-Object { Test-Path -LiteralPath $_ })
  $script:Rec = $null
  $J.started = @($J.started | Where-Object { $_ -and $_.role -ne 'record' })
  [void](Save-Journal)
  if ($left.Count) { Add-Event "Aufnahme ließ sich nicht löschen: $($left -join ', ')" 'warn' }
  else { Add-Event "Aufnahme gelöscht: $(Split-Path -Leaf $r.out)" }
}

# Every 2 s while one runs: the recorder ended by itself (done or failed), or the disk is nearly full.
function Watch-Recording {
  if (-not $script:Rec) { return }
  if (-not (Test-Recording)) { Complete-Recording; return }
  $free = Get-RecordFree
  if ($free -ge 0 -and $free -lt $RecordMinFree) {
    Add-Event ('Nur noch {0:0.0} GB frei: Aufnahme beendet' -f ($free / 1GB)) 'warn'
    Stop-Recording
  }
}

# ---- start everything
$script:HubStatus = Get-HubStatus
if ($script:HubStatus) {
  if (-not (Test-Ours $script:HubOurs)) { Add-Event "Kinect-Hub läuft schon auf :$Hub (Quelle: $($script:HubStatus.source)), wird mitbenutzt" }
} else {
  Start-Hub
  for ($i = 0; $i -lt 40 -and -not $script:HubStatus; $i++) { Start-Sleep -Milliseconds 500; $script:HubStatus = Get-HubStatus }
}

$script:Vite = Get-DevServer
if ($script:Vite) {
  $viteHub = ([string]$script:Vite.hub).TrimEnd('/')
  if ($viteHub -and $viteHub -ne $HubUrl) {
    $answer = 'n'
    if ($Interactive) { $answer = Read-Host "  Der Dev-Server im main ($($script:Vite.url)) nutzt den Hub $viteHub statt $HubUrl. Neu starten? [J/n]" }
    if ($answer -notmatch '^[nN]') {
      Stop-Tree ([int]$script:Vite.pid)
      Add-Event "Dev-Server mit Hub $viteHub beendet"
      $script:Vite = $null
      Start-Sleep -Seconds 1
    } else {
      Add-Event "Der Dev-Server nutzt den Hub $viteHub (nicht $HubUrl)" 'warn'
    }
  }
  if ($script:Vite -and -not (Test-Ours $script:ViteOurs)) { Add-Event "Dev-Server läuft schon: $($script:Vite.url), wird mitbenutzt" }
}
if (-not $script:Vite) { Start-Vite }

$script:NextTry.hubPoll = 10
if ($script:WallAuto) { Watch-Components }
if (-not $NoControl) { Open-Control }
if (-not $Minimal) { Update-Tuning }

# ---------------------------------------------------------------------------------------------
# status screen and keys

$script:TopCpu = ''
if (-not $Minimal) { [void][KinectWandNative]::TopCpu(5) }   # the first call only takes the baseline
[void][KinectWandNative]::CpuPercent()

$script:Shown = @()          # the lines on screen ("color|text"): only changed lines get written
$script:ShownSize = ''
$script:ScreensText = ''
$script:ScreensTextVer = -1
function Show-Status {
  try {
    $w = [Math]::Max(40, [Console]::WindowWidth - 1)
    $rows = [Math]::Max(5, [Console]::WindowHeight - 1)
  } catch { return }   # no console to draw on (output redirected)
  $lines = New-Object System.Collections.ArrayList
  function L([string]$text, [string]$color = 'Gray') { [void]$lines.Add(@($text, $color)) }
  $up = $Clock.Elapsed
  if ($script:ConfirmUntil -gt $up.TotalSeconds) {
    $ask = switch ($script:ConfirmKind) {
      'record' { '{0} min aufnehmen (etwa {1:0.0} GB)? Einverständnis eingeholt?  [J] ja, andere Taste: nein' -f $RecordMinutes, ($RecordSize / 1GB) }
      'stoprec' { 'Aufnahme beenden?  [J] ja, behalten  [X] ja, löschen  andere Taste: weiter aufnehmen' }
      default { 'Wirklich beenden? Die Wand geht aus' + $(if ($script:Rec) { ', die Aufnahme endet (bleibt gespeichert)' }) + '.  [J] ja, andere Taste: nein' }
    }
    L ('  {0}  ({1:0} s)' -f $ask, ($script:ConfirmUntil - $up.TotalSeconds)) 'Yellow'
  }
  L ('  Kinect-Wand · {0}läuft seit {1}:{2:00} h' -f $(if ($Minimal) { 'Minimalmodus · ' } else { '' }), [int][Math]::Floor($up.TotalHours), $up.Minutes) 'Cyan'
  if ($null -eq $script:HotkeyBusy) {
    $t = Get-Content -LiteralPath $HotkeyFile -ErrorAction SilentlyContinue
    if ($t) { $script:HotkeyBusy = ($t -eq 'busy') }
  }
  L ("  NOTAUS: $HotkeyText" + $(if ($script:HotkeyBusy) { ' ist belegt! Desktop-Symbol ''Kinect-Wand NOTAUS'' nutzen' } else { ' (in jedem Fenster) oder Desktop-Symbol ''Kinect-Wand NOTAUS''' })) 'Red'
  L ''
  $h = $script:HubStatus
  if ($h) {
    $st = [string]$h.sensor.state
    $sensor = switch ($st) { 'streaming' { 'läuft' } 'searching' { 'sucht' } 'starting' { 'startet' } 'offline' { 'aus' } default { $st } }
    if ($h.source -ne 'kinect') { $sensor = "Quelle $($h.source)" }
    $detail = if ($st -ne 'streaming' -and $h.sensor.detail) { " ($($h.sensor.detail))" } else { '' }
    $color = if ($st -eq 'streaming' -and $h.fps -ge 25) { 'Green' } elseif ($st -eq 'streaming') { 'Yellow' } else { 'Red' }
    L ('  Kinect     {0:0} fps · Sensor {1}{2} · {3} Personen · Pose {4} {5:0} ms' -f [double]$h.fps, $sensor, $detail, [int]$h.tracking.persons, $h.pose.active, [double]$h.pose.ms) $color
    $pages = @($h.render | Where-Object { $_ -and $_.visible })
    if ($pages.Count) {
      L ('  Szenen     ' + (($pages | ForEach-Object { '{0} {1:0}/{2:0} fps' -f $(if ($_.scene) { $_.scene } else { 'Seite' }), [double]$_.fps, [double]$_.target }) -join ' · '))
    } else { L '  Szenen     keine sichtbare Seite rendert' 'DarkGray' }
  } else {
    L "  Kinect     der Hub $HubUrl antwortet nicht" 'Red'
    L ''
  }
  $hubText = if (Test-Ours $script:HubOurs) { "von hier gestartet (PID $($script:HubOurs.pid))" } else { 'mitbenutzt' }
  if ($h) { $hubText += " · Worker-Neustarts $($h.worker.restarts) · Clients $($h.clients)" }
  L "  Hub        $HubUrl $hubText"
  if ($script:Vite) {
    $viteText = if ($script:ViteOurs -and [int]$script:ViteOurs.pid -eq [int]$script:Vite.pid) { 'von hier gestartet' } else { 'mitbenutzt' }
    L "  Dev-Server $($script:Vite.url) $viteText (PID $($script:Vite.pid))"
  } else { L '  Dev-Server läuft nicht' 'Red' }
  if ($script:WallPid) { $wallText = "offen auf $(Format-Screen $script:WallScreen)" }
  elseif ($script:ScreenMissing -eq 'mirror' -and $script:WallAuto) { $wallText = 'zu: der zweite Bildschirm spiegelt das Notebook (Win+P: Erweitern)' }
  elseif ($script:ScreenMissing -and $script:WallAuto) { $wallText = 'zu: kein zweiter Bildschirm (nie auf dem Notebook)' }
  else { $wallText = 'zu' }
  $wallText += if ($script:WallAuto) { ' · geht es zu, öffnet es sich wieder' } else { ' · automatisch öffnen: aus (W)' }
  L "  Wand       $wallText" $(if ($script:WallPid -or -not $script:WallAuto) { 'Gray' } else { 'Yellow' })
  if ($script:ControlPid) { L '  Steuerung  Steuerzentrale offen auf dem Notebook-Bildschirm (S holt sie dorthin zurück)' }
  else { L '  Steuerung  Steuerzentrale zu (S öffnet sie auf dem Notebook-Bildschirm)' 'DarkGray' }
  if ($script:Rec) {
    $t = 0; $bytes = 0
    if ($script:Rec.start) { $t = ([DateTime]::UtcNow - [DateTime]::FromFileTimeUtc([long]$script:Rec.start)).TotalSeconds }
    foreach ($f in "$($script:Rec.out).part", [string]$script:Rec.out) { if ([IO.File]::Exists($f)) { $bytes = (New-Object IO.FileInfo $f).Length; break } }
    L ('  Aufnahme   LÄUFT {0} von {1} min · {2:0.0} GB · {3} · R beendet' -f (Format-Time $t), (Format-Time $script:Rec.seconds), ($bytes / 1GB), (Split-Path -Leaf $script:Rec.out)) 'Magenta'
  } else {
    $free = Get-RecordFree
    $room = $free -lt 0 -or $free -ge $RecordSize + $RecordReserve
    $text = '  Aufnahme   R nimmt {0} min auf (Tiefe + Infrarot, etwa {1:0.0} GB)' -f $RecordMinutes, ($RecordSize / 1GB)
    if ($free -ge 0) { $text += ' · frei: {0:0.0} GB' -f ($free / 1GB) }
    if (-not $room) { $text += ', zu wenig Platz' }
    L $text $(if ($room) { 'DarkGray' } else { 'Yellow' })
  }
  if ($script:ScreensTextVer -ne [KinectWandNative]::ScreensVersion) {
    $script:ScreensTextVer = [KinectWandNative]::ScreensVersion
    $script:ScreensText = (@([KinectWandNative]::Screens()) | Sort-Object X | ForEach-Object { Format-Screen $_ }) -join ' · '
  }
  L "  Schirme    $($script:ScreensText)" 'DarkGray'
  $cpu = [KinectWandNative]::CpuPercent()
  $power = [KinectWandNative]::Power()
  L ('  Rechner    CPU {0:0} % · RAM frei {1:0.0} GB · {2}' -f [Math]::Max(0, $cpu), [KinectWandNative]::FreeMemoryGB(), $power) $(if ($power -like 'AKKU*') { 'Yellow' } else { 'Gray' })
  if (-not $Minimal) { L "  Viel CPU   $($script:TopCpu)" 'DarkGray' }
  L ''
  if ($script:Optimize -and $Minimal) { L '  Optimiert  minimal: Energieplan nur gegen Standby/Deckel/USB-Sparen, die CPU regelt Windows · keine Prioritäten' 'DarkGreen' }
  elseif ($script:Optimize) { L "  Optimiert  Energieplan · kein Standby/Bildschirm aus · $($script:TuneSummary)" 'DarkGreen' }
  else { L '  Optimiert  nein, zurückgestellt (der Bildschirm bleibt trotzdem an)' 'DarkGray' }
  L ''
  L '  [Q] Beenden  [W] Wand-Fenster zu/auf  [S] Steuerzentrale  [R] Aufnahme  [O] Optimierungen zurück  [L] Logs' 'White'
  L ''
  foreach ($e in $Events) { L ('  {0:HH:mm:ss} {1}' -f $e.t, $e.text) $(if ($e.level -eq 'warn') { 'Yellow' } else { 'DarkGray' }) }

  # write only what changed (a full redraw only when the window changed its size)
  if ("$w x $rows" -ne $script:ShownSize) { Clear-Host; $script:Shown = @(); $script:ShownSize = "$w x $rows" }
  $count = [Math]::Min($rows, [Math]::Max($lines.Count, $script:Shown.Count))
  $shown = New-Object string[] $count
  for ($i = 0; $i -lt $count; $i++) {
    $t = ''; $c = 'Gray'
    if ($i -lt $lines.Count) { $t = [string]$lines[$i][0]; $c = [string]$lines[$i][1] }
    if ($t.Length -gt $w) { $t = $t.Substring(0, $w) }
    $shown[$i] = "$c|$t"
    if ($i -lt $script:Shown.Count -and $script:Shown[$i] -eq $shown[$i]) { continue }
    try { [Console]::SetCursorPosition(0, $i) } catch { }
    [Console]::ForegroundColor = $c
    [Console]::Write($t.PadRight($w))
  }
  [Console]::ResetColor()
  $script:Shown = $shown
}

function Stop-Optimizing {
  $script:Optimize = $false
  $problems = @(Restore-Power $J)
  Restore-Processes $J
  $J.tuned = @()
  $J.power.temp = $null
  [void](Save-Journal)
  Add-Event ('Optimierungen zurückgestellt' + $(if ($problems.Count) { ': ' + ($problems -join '; ') } else { '' }))
}

function Invoke-Quit {
  try { [Console]::TreatControlCAsInput = $false } catch { }
  [KinectWandNative]::SetInputMode($ConsoleMode)
  try { [Console]::CursorVisible = $true } catch { }
  Clear-Host
  Write-Host "`n  Beende: stelle alles zurück und stoppe, was hier gestartet wurde ...`n" -ForegroundColor Cyan
  $script:Drawn = $false   # events go straight to the console again
  if ($script:Rec) { Stop-Recording }
  $r = Restore-All $J -StopStarted
  [KinectWandNative]::KeepAwake($false)
  New-Item -ItemType File -Force $GuardStopFlag | Out-Null
  foreach ($p in $r.problems) { Write-Host "  $p" -ForegroundColor Yellow }
  Write-EventLog 'beendet, alles zurückgestellt'
  Write-Host '  Fertig: alles ist wieder wie vorher. (Das Fenster schließt sich gleich.)' -ForegroundColor Green
  Start-Sleep -Seconds 4
}

$script:Drawn = $true
# nothing here may wait for the user: the watchdog runs in this loop. Between the checks it sleeps
# (WaitInput), a key wakes it at once.
$ConsoleMode = [KinectWandNative]::NoQuickEdit()
try { [Console]::TreatControlCAsInput = $true } catch { }
try { [Console]::CursorVisible = $false } catch { }
Clear-Host
$nextWatch = 0; $nextTune = 15; $nextDraw = 0; $nextCpu = 9; $nextPlace = 0; $nextScan = 0; $nextAwake = 60
$script:ConfirmUntil = 0
$script:ConfirmKind = ''   # what the question at the top is about: quit, record, stoprec
$quit = $false
while (-not $quit) {
  $now = $Clock.Elapsed.TotalSeconds
  try {
    if ([IO.File]::Exists($QuitFlag)) { Remove-Item $QuitFlag -ErrorAction SilentlyContinue; $quit = $true; break }
    if ($Interactive -and [Console]::KeyAvailable) {
      $k = [Console]::ReadKey($true)
      $ch = [char]::ToLower($k.KeyChar)
      if ($script:ConfirmUntil -gt $now) {
        $script:ConfirmUntil = 0
        $yes = $ch -in 'j', 'y'
        if ($script:ConfirmKind -eq 'record') {
          if ($yes) { Start-Recording } else { Add-Event 'Aufnahme nicht gestartet' }
        } elseif ($script:ConfirmKind -eq 'stoprec') {
          if ($yes) { Stop-Recording } elseif ($ch -eq 'x') { Stop-Recording -Delete } else { Add-Event 'Aufnahme läuft weiter' }
        } elseif ($yes) { $quit = $true; break }
        else { Add-Event 'Beenden abgebrochen' }
      } elseif ($ch -eq 'q' -or ($k.Key -eq 'C' -and ($k.Modifiers -band [ConsoleModifiers]::Control))) {
        $script:ConfirmKind = 'quit'
        $script:ConfirmUntil = $now + 10
      } elseif ($ch -eq 'r') {
        Watch-Recording   # one that just ended is taken in first
        if ($script:Rec) { $script:ConfirmKind = 'stoprec'; $script:ConfirmUntil = $now + 10 }
        else {
          # what would stop a recording is said before anyone is asked
          $why = Get-RecordBlocker
          if ($why) { Add-Event $why 'warn' } else { $script:ConfirmKind = 'record'; $script:ConfirmUntil = $now + 10 }
        }
      } elseif ($ch -eq 'w') {
        if ($script:WallPid) { $script:WallAuto = $false; Close-Wall; Add-Event 'Wand-Fenster geschlossen (W öffnet es wieder)' }
        else { $script:WallAuto = $true; $script:WallLaunches.Clear(); $script:NextTry.wall = 0; $nextWatch = 0 }
      } elseif ($ch -eq 's') {
        Open-Control
      } elseif ($ch -eq 'o') {
        if ($script:Optimize) { Stop-Optimizing }
      } elseif ($ch -eq 'l') {
        Start-Process explorer.exe $StateDir
      }
      $nextDraw = 0
    }
    if ($now -ge $nextPlace) {
      # our window(s) twice a second, all windows every 2 s (a wall browser opened elsewhere);
      # minimal: every 2 s and every 10 s
      $full = $now -ge $nextScan
      if ($full) { $nextScan = $now + $ScanEvery }
      $bad = [KinectWandNative]::WallScan([int]$script:WallPid, $WallProfile, $full)
      if ($bad.Length -or $script:InternalSince.Count -or $script:WallPlaceVer -ne [KinectWandNative]::PlaceVersion) { [void](Test-WallPlace $bad) }
      $nextPlace = $now + $PlaceEvery
    }
    if ($now -ge $nextWatch) {
      Watch-Components
      Watch-Recording
      if (-not (Test-Alive $J.guardPid $J.guardStart)) { Add-Event 'Wächter neu gestartet' 'warn'; Start-Guard }
      $nextWatch = $now + 2
    }
    if ($now -ge $nextAwake) { [KinectWandNative]::KeepAwake($true); $nextAwake = $now + 60 }
    if ($script:ConfirmUntil -and $script:ConfirmUntil -le $now) { $script:ConfirmUntil = 0; $nextDraw = 0 }
    if ($script:Optimize -and -not $Minimal -and $now -ge $nextTune) { Update-Tuning; $nextTune = $now + 15 }
    if ($now -ge $nextDraw -or $script:Dirty) {
      if (-not $Minimal -and $now -ge $nextCpu) { $script:TopCpu = [KinectWandNative]::TopCpu(5); $nextCpu = $now + 9 }
      Show-Status
      $script:Dirty = $false
      $nextDraw = $now + $(if ($script:ConfirmUntil) { 1 } elseif ($script:Rec) { 5 } else { $DrawEvery })
    }
  } catch {
    Add-Event "Fehler: $($_.Exception.Message)" 'warn'
    $script:Dirty = $false   # shown with the next regular draw, not again at once
    $nextWatch = $now + 2; $nextDraw = $now + 1
  }
  if ($Interactive) { [KinectWandNative]::WaitInput(500) } else { Start-Sleep -Milliseconds 500 }
}
Invoke-Quit
