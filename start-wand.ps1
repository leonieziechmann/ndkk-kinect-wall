<#
  start-wand.ps1: starts everything the LED wall needs and tunes Windows for it, only while it runs.

    start-wand.cmd                     double-click (or the desktop icon "Kinect-Wand starten")
    .\start-wand.ps1 [-NoWall] [-NoControl] [-NoAdmin] [-Hub 8091]
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

  Tunes while it runs:
    - power plan: a temporary copy of "High performance": no sleep, no display off, lid closed = do
      nothing, USB selective suspend and PCIe link power saving off (Kinect), CPU min 100 %, boost
    - no sleep or display off (SetThreadExecutionState, ends with this process)
    - priorities: hub and depth worker high, the kiosk browser above normal, these never in efficiency
      mode; chat/sync apps (Teams, WhatsApp, Signal, Phone Link, OneDrive, ...), test hubs, headless
      test browsers and the dev servers of other worktrees in efficiency mode (idle + EcoQoS)
    - after one UAC prompt: Windows Search indexer, SysMain, telemetry and Windows Update (wuauserv,
      UsoSvc, DoSvc, BITS) stopped (not disabled)

  Getting the old values back, whatever happens:
    - every original value is written to %LOCALAPPDATA%\kinect-wand\journal.json (services:
      services.json) BEFORE it is changed
    - Q here: everything back, and what this program started is stopped
    - this window closed or the program crashed: a hidden guard process does the same
    - NOTAUS Strg+Alt+Shift+N (the guard; works in every window) or the desktop icon: ends this
      program, puts everything back, stops what it started
    - PC crashed, restarted or signed out: priorities, efficiency mode and the sleep block end with
      their processes, stopped services start again with Windows; the power plan comes back at the next
      sign-in (RunOnce), the services also through a one-time task at the next sign-in (fast startup
      would keep them stopped); the next start of this program cleans up what is left in the journal
#>
[CmdletBinding()]
param(
  [switch]$NoWall,    # no output window (e.g. without the LED screen)
  [switch]$NoAdmin,   # no UAC prompt: Windows services stay as they are
  [switch]$NoControl, # no control center window on the notebook
  [int]$Hub = 8090,   # the hub to use; only the real one on 8090 is started, others must run already
  [switch]$Panic,     # NOTAUS
  [int]$Guard = 0,    # internal: be the guard of this PID
  [int]$AdminFor = 0, # internal: be the elevated helper (services) of this PID
  [string]$Checkout   # for tests: use this checkout instead of the main one
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$StateDir = Join-Path $env:LOCALAPPDATA 'kinect-wand'
$LogDir = Join-Path $StateDir 'logs'
$JournalFile = Join-Path $StateDir 'journal.json'
$ServicesFile = Join-Path $StateDir 'services.json'
$HotkeyFile = Join-Path $StateDir 'hotkey.txt'
$GuardStopFlag = Join-Path $StateDir 'guard-stop.flag'
$ServicesFlag = Join-Path $StateDir 'services-restore.flag'
$QuitFlag = Join-Path $StateDir 'quit.flag'      # written by anyone: the main program ends cleanly (as with Q)
$EventLog = Join-Path $StateDir 'start-wand.log'
# stdin of the hub and the dev server: without it, Start-Process hands them this console's input,
# Vite reads it as a terminal and takes the events [Console]::KeyAvailable waits for (it hangs)
$NoInput = Join-Path $StateDir 'no-input.txt'
$RunOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$RunOnceName = 'KinectWandEnergieplan'
$ServiceTask = 'KinectWand-Dienste'
$PowerName = 'Kinect-Wand (Startskript)'
$HighPerf = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
$Balanced = '381b4222-f694-41f0-9685-ff5bb260df2e'
$HotkeyText = 'Strg+Alt+Shift+N'
$HotkeyMods = 0x0002 -bor 0x0001 -bor 0x0004   # MOD_CONTROL | MOD_ALT | MOD_SHIFT
$HotkeyVk = 0x4E                                # N

# Windows services that work in the background: stopped while the show runs (never disabled)
$Services = @('WSearch', 'SysMain', 'DiagTrack', 'wuauserv', 'UsoSvc', 'DoSvc', 'BITS')
# apps put into efficiency mode while the show runs (process names without .exe; also their WebView2)
$BackgroundApps = @('ms-teams', 'Teams', 'WhatsApp', 'WhatsApp.Root', 'Signal', 'PhoneExperienceHost',
  'CrossDeviceService', 'OneDrive', 'Spotify', 'Discord', 'Dropbox', 'GoogleDriveFS', 'Widgets',
  'WidgetService', 'Telegram', 'slack', 'Zoom', 'olk', 'OUTLOOK', 'steam', 'steamwebhelper',
  'EpicGamesLauncher', 'EADesktop', 'Battle.net')
# power plan values: subgroup, setting, AC, DC ($null: as in "High performance")
$PowerSettings = @(
  @('238c9fa8-0aad-41ed-83f4-97be242c8f20', '29f6c1db-86da-48c5-9fdb-f2b67b1f44da', 0, 0),       # sleep after: never
  @('238c9fa8-0aad-41ed-83f4-97be242c8f20', '9d7815a6-7ee4-497e-8888-515a05f02364', 0, 0),       # hibernate after: never
  @('7516b95f-f776-4464-8c53-06167f40cc99', '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e', 0, 0),       # display off after: never
  @('7516b95f-f776-4464-8c53-06167f40cc99', '17aaa29b-8b43-4b94-aafe-35f64daaf1ee', 0, 0),       # dim display after: never
  @('0012ee47-9041-4b5d-9b77-535fba8b1442', '6738e2c4-e8a5-4a42-b16a-e040e769756e', 0, 0),       # disk off after: never
  @('4f971e89-eebd-4455-a8de-9e59040e7347', '5ca83367-6e45-459f-a27b-476b1d01c936', 0, 0),       # lid closed: do nothing
  @('2a737441-1930-4402-8d77-b2bebba308a3', '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', 0, 0),       # USB selective suspend: off
  @('501a4d13-42af-4429-9fd1-a8218c268e20', 'ee12f906-d277-404b-b6da-e5fa1a576df5', 0, 0),       # PCIe link power saving: off
  @('54533251-82be-4824-96c1-47b60b740d00', '893dee8e-2bef-41e0-89c6-b55d0929964c', 100, $null), # min processor state: 100 %
  @('54533251-82be-4824-96c1-47b60b740d00', 'be337238-0d82-4146-a960-4f3749d470c7', 2, $null),   # processor boost: aggressive
  @('19cbb8fa-5279-450e-9fac-8a3d5fedd0c1', '12bbebe6-58d6-4636-95bb-3217ef867c1a', 0, 0),       # Wi-Fi power saving: off
  @('de830923-a562-41af-a086-e3a2c6bad2da', 'e69653ca-cf7f-4f05-aa73-cb833fa90ad4', $null, 0)    # energy saver from battery level: never
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class KinectWandNative {
  [StructLayout(LayoutKind.Sequential)] struct Throttling { public uint Version; public uint ControlMask; public uint StateMask; }
  [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MemStatus { public uint Length; public uint Load; public ulong TotalPhys; public ulong AvailPhys; public ulong TotalPage; public ulong AvailPage; public ulong TotalVirtual; public ulong AvailVirtual; public ulong AvailExtended; }
  [StructLayout(LayoutKind.Sequential)] struct PowerStatus { public byte AcLine; public byte Flag; public byte Percent; public byte Saver; public int LifeTime; public int FullLifeTime; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr h, int cls, ref Throttling info, int size);
  [DllImport("kernel32.dll")] static extern bool GetProcessInformation(IntPtr h, int cls, ref Throttling info, int size);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MemStatus m);
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus s);
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
        uint r = MsgWaitForMultipleObjects(1, new[] { h }, false, 500, 0x04FF);
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

  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PathInfo[] paths, ref uint numModes, [Out] ModeInfo[] modes, IntPtr topology);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SourceName r);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref TargetName r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MonitorInfoEx mi);

  public class Display { public string Device; public string Name; public int X, Y, Width, Height; public bool Internal; public uint Technology; }

  // The active displays: GDI name, place on the desktop in physical pixels, the monitor's name and
  // whether it is the notebook's own panel (connected as LVDS, embedded DisplayPort, embedded UDI
  // or "internal").
  public static Display[] Displays() {
    uint np, nm;
    if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return new Display[0];
    var paths = new PathInfo[np];
    var modes = new ModeInfo[nm];
    if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return new Display[0];
    var list = new System.Collections.Generic.List<Display>();
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

  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  // The visible windows (larger than 100 x 100) on the notebook's own panel, with their process.
  static System.Collections.Generic.List<KeyValuePair<IntPtr, int>> InternalWindows() {
    var inner = new System.Collections.Generic.HashSet<string>();
    foreach (var d in Displays()) if (d.Internal && d.Device != null) inner.Add(d.Device);
    var list = new System.Collections.Generic.List<KeyValuePair<IntPtr, int>>();
    if (inner.Count == 0) return list;
    EnumWindows((h, l) => {
      Rect r;
      if (IsWindowVisible(h) && GetWindowRect(h, out r) && r.Right - r.Left > 100 && r.Bottom - r.Top > 100) {
        var mi = new MonitorInfoEx { cbSize = Marshal.SizeOf(typeof(MonitorInfoEx)) };
        if (GetMonitorInfo(MonitorFromWindow(h, 2), ref mi) && inner.Contains(mi.device)) {
          uint wp;
          GetWindowThreadProcessId(h, out wp);
          list.Add(new KeyValuePair<IntPtr, int>(h, (int)wp));
        }
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // The processes that have a window on the notebook's own panel.
  public static int[] InternalWindowPids() {
    var pids = new System.Collections.Generic.List<int>();
    foreach (var w in InternalWindows()) if (!pids.Contains(w.Value)) pids.Add(w.Value);
    return pids.ToArray();
  }

  // Sends WM_CLOSE to every window of these processes that is on the notebook's own panel;
  // returns the processes that had one.
  public static int[] CloseOnInternal(int[] pids) {
    var bad = new System.Collections.Generic.List<int>();
    foreach (var w in InternalWindows()) {
      if (Array.IndexOf(pids, w.Value) < 0) continue;
      PostMessage(w.Key, 0x0010, IntPtr.Zero, IntPtr.Zero);
      if (!bad.Contains(w.Value)) bad.Add(w.Value);
    }
    return bad.ToArray();
  }

  // ---- processes, cheaply (Get-Process lists every process each time)

  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, System.Text.StringBuilder name, ref int size);

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
      var sb = new System.Text.StringBuilder(1024);
      int size = sb.Capacity;
      return QueryFullProcessImageName(h, 0, sb, ref size) ? Path.GetFileName(sb.ToString()).ToLowerInvariant() : "";
    } finally { CloseHandle(h); }
  }

  // ---- console: quick edit off (a click into the window would pause this program until a key)

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint m);

  public static long NoQuickEdit() {
    IntPtr h = GetStdHandle(-10);
    uint m;
    if (!GetConsoleMode(h, out m)) return -1;
    SetConsoleMode(h, (m & ~0x40u) | 0x80u);
    return m;
  }

  public static void SetInputMode(long m) { if (m >= 0) SetConsoleMode(GetStdHandle(-10), (uint)m); }

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

# ---------------------------------------------------------------------------------------------
# helpers

function Write-EventLog([string]$text) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}' -f (Get-Date), $PID, $text
  for ($i = 0; $i -lt 5; $i++) {
    try { [IO.File]::AppendAllText($EventLog, $line + "`r`n"); return } catch { Start-Sleep -Milliseconds 50 }
  }
}

# A process is named by its PID and start time (a PID alone may belong to a new process later).
function Get-StartKey($proc) {
  $t = [KinectWandNative]::StartTime([int]$proc.Id)
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

# The process if it is still the same one, else $null.
function Get-SameProcess($id, $start) {
  if (-not (Test-Alive $id $start)) { return $null }
  return Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
}

function Stop-Tree([int]$id, [switch]$Gentle) {
  if ($Gentle) {
    $null = & taskkill.exe /PID $id /T 2>$null
    for ($i = 0; $i -lt 30 -and (Get-Process -Id $id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
  }
  if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $null = & taskkill.exe /PID $id /T /F 2>$null }
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
  $temps = @($schemes.Keys | Where-Object { $schemes[$_] -eq $PowerName })
  if ($j -and $j.power -and $j.power.temp) { $temps = @($temps + [string]$j.power.temp | Select-Object -Unique) }
  if ($active -and $temps -contains $active) {
    $target = $null
    if ($j -and $j.power -and $j.power.original) { $target = [string]$j.power.original }
    if (-not $target -or $temps -contains $target -or -not (Test-Scheme $target)) {
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
    if (-not $t) { continue }
    $p = Get-SameProcess $t.pid $t.start
    if (-not $p) { continue }
    try { if ($t.prio) { $p.PriorityClass = [string]$t.prio } } catch { }
    if ($null -ne $t.throttle -and [long]$t.throttle -ge 0) { [void][KinectWandNative]::SetThrottle([int]$t.pid, [long]$t.throttle) }
  }
}

function Stop-Started($j) {
  $stopped = @()
  foreach ($role in 'wall', 'control', 'vite', 'hub') {
    foreach ($s in @($j.started)) {
      if (-not $s -or $s.role -ne $role) { continue }
      if (Get-SameProcess $s.pid $s.start) {
        Stop-Tree ([int]$s.pid) -Gentle:($role -in 'wall', 'control')
        $stopped += $role
      }
    }
  }
  return $stopped
}

# Everything back: power plan, priorities, services (the elevated helper), started processes.
function Restore-All($j, [switch]$StopStarted) {
  $problems = @(Restore-Power $j)
  if ($j) { Restore-Processes $j }
  New-Item -ItemType File -Force $ServicesFlag | Out-Null
  $stopped = @()
  if ($StopStarted -and $j) { $stopped = @(Stop-Started $j) }
  if ($j) {
    $j.active = $false
    try { Write-Json $JournalFile $j } catch { $problems += "Journal: $($_.Exception.Message)" }
  }
  return [pscustomobject]@{ problems = $problems; stopped = $stopped }
}

# Waits until the elevated helper has started the services again (if one is at work).
function Wait-ServicesRestored([int]$seconds) {
  for ($i = 0; $i -le $seconds * 4; $i++) {
    $svc = Read-Json $ServicesFile
    if (-not $svc -or $svc.restored) { return $true }
    # a helper rewrites the file at least every 20 s; an older one was killed and cannot finish
    if ((Get-Item -LiteralPath $ServicesFile).LastWriteTime -lt (Get-Date).AddSeconds(-60)) { return $false }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Invoke-Notaus([switch]$FromGuard) {
  $j = Read-Json $JournalFile
  if (-not $FromGuard -and $j -and $j.guardPid) {
    $g = Get-SameProcess $j.guardPid $j.guardStart
    if ($g) { Stop-Process -Id $g.Id -Force -ErrorAction SilentlyContinue }
  }
  if ($j -and $j.mainPid) {
    $m = Get-SameProcess $j.mainPid $j.mainStart
    if ($m) { Stop-Process -Id $m.Id -Force -ErrorAction SilentlyContinue }
  }
  $r = Restore-All $j -StopStarted
  $servicesOk = Wait-ServicesRestored 20
  $names = @{ wall = 'Wand-Fenster'; control = 'Steuerzentrale'; vite = 'Dev-Server'; hub = 'Kinect-Hub' }
  $msg = 'NOTAUS: alle Einstellungen sind zurückgestellt'
  if ($r.stopped.Count) { $msg += ', beendet: ' + (($r.stopped | ForEach-Object { $names[$_] }) -join ', ') }
  $msg += '.'
  if (-not $servicesOk) { $msg += "`n`nDie Windows-Dienste laufen spätestens nach dem nächsten Anmelden wieder." }
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

# ---------------------------------------------------------------------------------------------
# mode: elevated helper (Windows services), started with one UAC prompt

if ($AdminFor) {
  $adminLog = Join-Path $StateDir 'admin.log'
  function Write-AdminLog([string]$t) { try { [IO.File]::AppendAllText($adminLog, ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $t) + "`r`n") } catch { } }
  function Save-State { try { Write-Json $ServicesFile $state } catch { Write-AdminLog "services.json: $($_.Exception.Message)" } }
  $list = @()
  $state = $null
  try {
    # the true original: what a helper that never finished wrote down wins over the state now
    $old = Read-Json $ServicesFile
    $baseline = @{}
    if ($old -and -not $old.restored) { foreach ($s in @($old.services)) { if ($s) { $baseline[[string]$s.name] = [bool]$s.wasRunning } } }
    foreach ($name in $Services) {
      $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
      if (-not $svc) { continue }
      $was = if ($baseline.ContainsKey($name)) { $baseline[$name] } else { $svc.Status -eq 'Running' }
      $list += [pscustomobject]@{ name = $name; wasRunning = $was; now = [string]$svc.Status; note = '' }
    }
    $state = [pscustomobject]@{ restored = $false; parent = $AdminFor; services = $list }
    Write-Json $ServicesFile $state   # must work: nothing is stopped before the original is on disk

    # for a crash or fast startup: once at the next sign-in or boot, start them again
    $running = @($list | Where-Object { $_.wasRunning } | ForEach-Object { $_.name })
    if ($running.Count) {
      $cmd = (@($running | ForEach-Object { "sc.exe start $_" }) + "schtasks.exe /delete /tn $ServiceTask /f") -join ' & '
      $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd"
      $triggers = @((New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -AtStartup))
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Register-ScheduledTask -TaskName $ServiceTask -Action $action -Trigger $triggers -Principal $principal -Force -ErrorAction Stop | Out-Null
      Write-AdminLog "Aufgabe $ServiceTask für die nächste Anmeldung: cmd.exe /c $cmd"
    }

    function Stop-Ours {
      foreach ($s in $list) {
        $svc = Get-Service -Name $s.name -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Stopped') {
          try { Stop-Service -Name $s.name -Force -ErrorAction Stop; $s.note = '' } catch { $s.note = 'gesperrt' }
        }
        $svc = Get-Service -Name $s.name -ErrorAction SilentlyContinue
        if ($svc) { $s.now = [string]$svc.Status }
      }
      Save-State
    }
    Stop-Ours
    Write-AdminLog ('angehalten: ' + (($list | ForEach-Object { "$($_.name)=$($_.now)$(if ($_.note) { " ($($_.note))" })" }) -join ', '))

    $tick = 0
    while ((Get-Process -Id $AdminFor -ErrorAction SilentlyContinue) -and -not (Test-Path $ServicesFlag)) {
      Start-Sleep -Seconds 2
      if ((++$tick % 10) -eq 0) { Stop-Ours }   # Windows starts some of them again on its own
    }
  } catch {
    Write-AdminLog "Fehler: $($_.Exception.Message)"
  } finally {
    foreach ($s in $list) {
      if ($s.wasRunning) {
        try { Start-Service -Name $s.name -ErrorAction Stop } catch { Write-AdminLog "$($s.name) startet nicht: $($_.Exception.Message)" }
      }
      $svc = Get-Service -Name $s.name -ErrorAction SilentlyContinue
      if ($svc) { $s.now = [string]$svc.Status }
    }
    if ($state) { $state.restored = $true; Save-State }
    Unregister-ScheduledTask -TaskName $ServiceTask -Confirm:$false -ErrorAction SilentlyContinue
    Write-AdminLog ('zurückgestellt: ' + (($list | ForEach-Object { "$($_.name)=$($_.now)" }) -join ', '))
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
function Add-Event([string]$text, [string]$level = 'info') {
  [void]$Events.Add([pscustomobject]@{ t = Get-Date; text = $text; level = $level })
  while ($Events.Count -gt 7) { $Events.RemoveAt(0) }
  Write-EventLog $text
  if (-not $script:Drawn) { Write-Host "  $text" -ForegroundColor $(if ($level -eq 'warn') { 'Yellow' } else { 'Gray' }) }
}

# one program at a time; clean up after a run that did not end properly
$old = Read-Json $JournalFile
if ($old -and $old.active -and (Get-SameProcess $old.mainPid $old.mainStart)) {
  Write-Host "`n  Die Wand läuft schon (PID $($old.mainPid)). Beenden dort mit Q, Notaus: $HotkeyText.`n" -ForegroundColor Yellow
  if ($Interactive) { [void](Read-Host '  Enter zum Schließen') }
  exit 1
}
$adopt = @()
if ($old -and $old.active) {
  Write-Host '  Der letzte Lauf endete nicht sauber: stelle zurück, was noch übrig ist ...' -ForegroundColor Yellow
  foreach ($s in @($old.started)) { if ($s -and (Get-SameProcess $s.pid $s.start)) { $adopt += $s } }
  $r = Restore-All $old
  foreach ($p in $r.problems) { Write-Host "  $p" -ForegroundColor Yellow }
}
[void](Wait-ServicesRestored 15)   # a helper of the last run puts its services back first
Remove-Item $GuardStopFlag, $ServicesFlag, $HotkeyFile, $QuitFlag -ErrorAction SilentlyContinue

$me = Get-Process -Id $PID
$J = [pscustomobject]@{
  version    = 1
  active     = $true
  mainPid    = $PID
  mainStart  = Get-StartKey $me
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

# ---- the guard: puts everything back when this window closes or crashes; NOTAUS hotkey
function Start-Guard {
  $g = Start-Process -FilePath $Ps -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Guard', $PID)
  $J.guardPid = $g.Id
  $J.guardStart = Get-StartKey $g
  [void](Save-Journal)
}
Start-Guard

# ---- Windows services (one UAC prompt)
$script:AdminState = 'aus'
if (-not $NoAdmin) {
  try {
    Start-Process -FilePath $Ps -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-AdminFor', $PID) | Out-Null
    $script:AdminState = 'an'
  } catch {
    Add-Event 'Ohne Admin-Rechte: die Windows-Dienste bleiben, wie sie sind.' 'warn'
  }
}

# ---- power plan (write-ahead: the journal and RunOnce know the way back before anything changes)
function Enable-PowerPlan {
  $orig = Get-ActiveScheme
  $schemes = Get-Schemes
  if (-not $orig -or $schemes[$orig] -eq $PowerName) { Add-Event 'Energieplan: aktiver Plan unklar, bleibt, wie er ist' 'warn'; return }
  $J.power.original = $orig
  if (-not (Save-Journal)) { return }
  $base = if (Test-Scheme $HighPerf) { $HighPerf } else { $orig }
  $out = & powercfg.exe /duplicatescheme $base 2>$null
  if ("$out" -notmatch '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { Add-Event 'Energieplan: Kopie fehlgeschlagen' 'warn'; return }
  $temp = $Matches[1].ToLower()
  $J.power.temp = $temp
  if (-not (Save-Journal)) { & powercfg.exe /delete $temp 2>$null | Out-Null; $J.power.temp = $null; return }
  & powercfg.exe /changename $temp $PowerName 'Voruebergehend von start-wand.ps1, wird beim Beenden geloescht' 2>$null | Out-Null
  $failed = 0
  foreach ($s in $PowerSettings) {
    if ($null -ne $s[2]) { & powercfg.exe /setacvalueindex $temp $s[0] $s[1] $s[2] 2>$null | Out-Null; if ($LASTEXITCODE) { $failed++ } }
    if ($null -ne $s[3]) { & powercfg.exe /setdcvalueindex $temp $s[0] $s[1] $s[3] 2>$null | Out-Null; if ($LASTEXITCODE) { $failed++ } }
  }
  New-ItemProperty -Path $RunOnceKey -Name $RunOnceName -PropertyType String -Force `
    -Value "cmd.exe /c powercfg /setactive $orig & powercfg /delete $temp" | Out-Null
  & powercfg.exe /setactive $temp 2>$null | Out-Null
  if ((Get-ActiveScheme) -eq $temp) {
    Add-Event ("Energieplan '$PowerName' aktiv" + $(if ($failed) { " ($failed Werte gibt es auf diesem Rechner nicht)" } else { '' }))
  } else {
    Add-Event 'Energieplan ließ sich nicht aktivieren' 'warn'
  }
}
Enable-PowerPlan
[KinectWandNative]::KeepAwake($true)
$script:Optimize = $true

# ---- priorities and efficiency mode
$script:Tuned = @{}   # "pid:start" of every process handled so far
function Get-Role($cim) {
  $cl = [string]$cim.CommandLine
  switch ($cim.Name) {
    'kinect-hub.exe' {
      $port = 8090
      if ($cl -match '--bind\s+"?[^\s"]*:(\d+)') { $port = [int]$Matches[1] }
      if ($port -eq $Hub) { return 'core' }
      return 'background'   # test hubs (replay, synthetic)
    }
    'fn2_capture.exe' { return 'core' }
    { $_ -in 'chrome.exe', 'msedge.exe' } {
      if ($cl.ToLower().Replace('/', '\').Contains($WallProfile)) {
        if ($cl -notmatch '--type=' -or $cl -match '--type=(gpu-process|renderer)') { return 'wall' }
        return $null
      }
      if ($cl -match '--headless') { return 'background' }   # test runs (npm run check)
      return $null
    }
    'node.exe' {
      if ($cl -match 'vite' -and -not $cl.ToLower().Contains($Web.ToLower() + '\')) { return 'background' }   # other worktrees
      return $null
    }
    'msedgewebview2.exe' {
      if ($cl -match '--webview-exe-name=([^\s"]+?)\.exe' -and $BackgroundApps -contains $Matches[1]) { return 'background' }
      return $null
    }
  }
  return $null
}

function Update-Tuning {
  $plan = @()
  $filter = "Name='kinect-hub.exe' OR Name='fn2_capture.exe' OR Name='chrome.exe' OR Name='msedge.exe' OR Name='node.exe' OR Name='msedgewebview2.exe'"
  foreach ($c in @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue)) {
    $role = Get-Role $c
    if ($role) { $plan += [pscustomobject]@{ id = [int]$c.ProcessId; role = $role } }
  }
  foreach ($p in @(Get-Process -Name $BackgroundApps -ErrorAction SilentlyContinue)) {
    $plan += [pscustomobject]@{ id = $p.Id; role = 'background' }
  }
  $J.tuned = @($J.tuned | Where-Object { $_ -and (Test-Alive $_.pid $_.start) })
  $new = @()
  foreach ($item in $plan) {
    $t = [KinectWandNative]::StartTime($item.id)
    if ($t -lt 0) { continue }
    $start = [string]$t
    $key = "$($item.id):$start"
    if ($script:Tuned.ContainsKey($key)) { continue }
    $p = Get-Process -Id $item.id -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    try { $prio = [string]$p.PriorityClass } catch { continue }
    $want = switch ($item.role) { 'core' { 'High' } 'wall' { 'AboveNormal' } default { 'Idle' } }
    $new += [pscustomobject]@{
      pid = $item.id; start = $start; name = $p.ProcessName; role = $item.role
      prio = $prio; throttle = [KinectWandNative]::GetThrottle($item.id)
      want = $want; eco = ($item.role -eq 'background')
    }
    $script:Tuned[$key] = $true
  }
  if (-not $new.Count) { return }
  $J.tuned = @($J.tuned) + @($new | Select-Object pid, start, name, role, prio, throttle)
  if (-not (Save-Journal)) { return }   # write-ahead: the old values are on disk before anything changes
  foreach ($n in $new) {
    $p = Get-Process -Id $n.pid -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    try { $p.PriorityClass = $n.want } catch { }
    [void][KinectWandNative]::SetEco($n.pid, $n.eco)
  }
}

function Get-TuneSummary {
  $alive = @($J.tuned | Where-Object { $_ })
  $core = @($alive | Where-Object { $_.role -eq 'core' }).Count
  $wall = @($alive | Where-Object { $_.role -eq 'wall' }).Count
  $bg = @($alive | Where-Object { $_.role -eq 'background' } | ForEach-Object { $_.name } | Select-Object -Unique)
  return "Hub/Worker hoch ($core) · Wand-Browser ($wall) · Effizienzmodus: $(if ($bg.Count) { $bg -join ', ' } else { '-' })"
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
$script:NextTry = @{ hub = 0; vite = 0; wall = 0 }
$Clock = [Diagnostics.Stopwatch]::StartNew()
foreach ($s in $adopt) {
  if ($s.role -eq 'hub') { $script:HubOurs = $s }
  if ($s.role -eq 'vite') { $script:ViteOurs = $s }
  if ($s.role -eq 'wall') { $script:WallPid = [int]$s.pid; $script:WallStart = $s.start }
  if ($s.role -eq 'control') { $script:ControlPid = [int]$s.pid; $script:ControlStart = $s.start }
}

function Add-Started([string]$role, $proc) {
  $entry = [pscustomobject]@{ role = $role; pid = $proc.Id; start = (Get-StartKey $proc) }
  $J.started = @($J.started | Where-Object { $_ -and $_.role -ne $role }) + $entry
  [void](Save-Journal)
  return $entry
}

function Test-Ours($entry) { return [bool]($entry -and (Test-Alive $entry.pid $entry.start)) }

function Get-HubStatus {
  try { return Invoke-RestMethod -Uri "$HubUrl/api/status" -TimeoutSec 2 } catch { return $null }
}

function Start-Hub {
  if ($Hub -ne 8090) { Add-Event "Hub :$Hub antwortet nicht (gestartet wird nur der echte Hub auf 8090)" 'warn'; return }
  if (-not (Test-Path $HubExe)) { Add-Event "kinect-hub.exe fehlt: $HubExe (im main bauen)" 'warn'; return }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $p = Start-Process -FilePath $HubExe -WorkingDirectory $Main -WindowStyle Hidden -PassThru -RedirectStandardInput $NoInput `
    -RedirectStandardOutput (Join-Path $LogDir "hub-$stamp.out.log") -RedirectStandardError (Join-Path $LogDir "hub-$stamp.log")
  $script:HubOurs = Add-Started 'hub' $p
  Add-Event "Kinect-Hub gestartet (PID $($p.Id))"
}

function Get-DevServer {
  $info = Read-Json (Join-Path $Web '.cache\dev-server.json')
  if (-not $info -or -not $info.url -or -not $info.pid) { return $null }
  if (-not (Get-Process -Id ([int]$info.pid) -ErrorAction SilentlyContinue)) { return $null }
  try { $null = Invoke-WebRequest -Uri "$($info.url)/__scenes" -UseBasicParsing -TimeoutSec 3 } catch { return $null }
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
  $script:ViteOurs = Add-Started 'vite' $p
  for ($i = 0; $i -lt 60 -and -not $p.HasExited; $i++) {
    Start-Sleep -Milliseconds 500
    $info = Get-DevServer
    if ($info -and [int]$info.pid -eq $p.Id) { $script:Vite = $info; break }
  }
  if ($script:Vite -and [int]$script:Vite.pid -eq $p.Id) { Add-Event "Dev-Server gestartet: $($script:Vite.url)" }
  else { Add-Event "Dev-Server startet nicht (Logs: L)" 'warn' }
}

function Find-Wall {
  # the main process of an output window (its own browser profile), or $null
  foreach ($c in @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue)) {
    $cl = [string]$c.CommandLine
    if ($cl -and $cl.ToLower().Replace('/', '\').Contains($WallProfile) -and $cl -notmatch '--type=') { return $c }
  }
  return $null
}

# The display for the output window, found automatically every time: the second display, never the
# notebook's own panel. Only with several other displays does the monitor name in the wall setup
# pick one (else the leftmost); $null while only the notebook's panel is there.
function Get-WallScreen {
  $all = @([KinectWandNative]::Displays())
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
  return [KinectWandNative]::Displays() | Where-Object { $_.Internal -and $_.Width -gt 0 } | Select-Object -First 1
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
$script:ControlPid = 0
$script:ControlStart = $null
$script:ControlUrl = $null

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
  foreach ($c in @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue)) {
    $cl = [string]$c.CommandLine
    if (-not $cl -or $cl -match '--type=' -or -not $cl.ToLower().Replace('/', '\').Contains($ControlProfile.ToLower())) { continue }
    if ($cl.Contains("--app=$url")) {
      $script:ControlPid = [int]$c.ProcessId; $script:ControlStart = [string][KinectWandNative]::StartTime($script:ControlPid); $script:ControlUrl = $script:Vite.url
      [void][KinectWandNative]::PlaceMaximized($script:ControlPid, $nb.X, $nb.Y, $nb.Width, $nb.Height)
      Add-Event 'Steuerzentrale ist schon offen, auf den Notebook-Bildschirm geholt'
      return
    }
    Stop-Tree ([int]$c.ProcessId) -Gentle
  }
  Set-NoTranslate $ControlProfile
  $browserArgs = @("--user-data-dir=`"$ControlProfile`"", '--no-first-run', '--no-default-browser-check', '--lang=de',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--disable-features=Translate',
    "--window-position=$($nb.X + 40),$($nb.Y + 40)", '--start-maximized', "--app=$url")
  $p = Start-Process -FilePath $exe -ArgumentList $browserArgs -PassThru
  $e = Add-Started 'control' $p
  $script:ControlPid = $p.Id
  $script:ControlStart = $e.start
  $script:ControlUrl = $script:Vite.url
  for ($i = 0; $i -lt 50 -and (Test-Alive $p.Id $e.start); $i++) {
    if ([KinectWandNative]::PlaceMaximized($p.Id, $nb.X, $nb.Y, $nb.Width, $nb.Height)) { break }
    Start-Sleep -Milliseconds 100
  }
  Add-Event 'Steuerzentrale geöffnet auf dem Notebook-Bildschirm'
}

# The display the output window is on now, $null while it shows no window yet.
function Get-WallPlace([int]$id) {
  $dev = [KinectWandNative]::WindowDisplay($id)
  if (-not $dev) { return $null }
  return [KinectWandNative]::Displays() | Where-Object { $_.Device -eq $dev } | Select-Object -First 1
}

function Format-Screen($d) {
  if (-not $d) { return '?' }
  $name = if ($d.Internal) { 'Notebook' } elseif ($d.Name) { $d.Name } else { $d.Device }
  return '{0} ({1}×{2} bei {3},{4})' -f $name, $d.Width, $d.Height, $d.X, $d.Y
}

$script:ScreenMissing = ''   # '' / 'none' / 'mirror': why the output window cannot open
$script:ScreenMirrored = $false
$script:WallScreen = $null
function Open-Wall {
  if (-not $script:Vite -or -not $Node) { return }
  $screen = Get-WallScreen
  if (-not $screen) {
    $why = if ($script:ScreenMirrored) { 'mirror' } else { 'none' }
    if ($script:ScreenMissing -ne $why) {
      if ($why -eq 'mirror') { Add-Event 'Der zweite Bildschirm zeigt dasselbe wie das Notebook: mit Win+P auf "Erweitern" stellen, dann geht das Wand-Fenster dort auf' 'warn' }
      else { Add-Event 'Kein zweiter Bildschirm: das Wand-Fenster bleibt zu, bis einer angeschlossen ist' 'warn' }
    }
    $script:ScreenMissing = $why
    return
  }
  if ($script:ScreenMissing) { Add-Event "Zweiter Bildschirm da: $(Format-Screen $screen)" }
  $script:ScreenMissing = ''
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
  if ($out -match 'PID (\d+)') {
    $p = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
    if ($p) {
      $e = Add-Started 'wall' $p
      $script:WallPid = $p.Id
      $script:WallStart = $e.start
      $script:WallUrl = $url
      $script:WallScreen = $screen
      # check at once where it really opened (closed within a fraction of a second if on the notebook)
      for ($i = 0; $i -lt 50 -and (Test-Alive $p.Id $e.start); $i++) {
        if (-not (Test-WallPlace)) { return }
        if ([KinectWandNative]::WindowDisplay($p.Id)) { break }
        Start-Sleep -Milliseconds 100
      }
      Add-Event "Wand-Fenster geöffnet auf $(Format-Screen $screen)"
      return
    }
  }
  Add-Event ('Wand-Fenster: ' + (($out -split "`n" | Where-Object { $_.Trim() }) -join ' ').Trim()) 'warn'
}

function Close-Wall([switch]$Now) {
  if ($script:WallPid) { Stop-Tree $script:WallPid -Gentle:(-not $Now) }
  $script:WallPid = 0
  $script:WallStart = $null
}

# Is this process the main process of a browser with the wall profile (ours, or one the control
# center opened)? Looked up once per process (command line), then remembered.
$script:WallCheck = @{}   # "pid:start" -> $true / $false
function Test-WallBrowser([int]$id) {
  $start = [KinectWandNative]::StartTime($id)
  if ($start -lt 0) { return $false }
  $key = "${id}:$start"
  if (-not $script:WallCheck.ContainsKey($key)) {
    $wall = $false
    if ([KinectWandNative]::ImageName($id) -in 'chrome.exe', 'msedge.exe') {
      $c = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
      $cl = [string]$c.CommandLine
      $wall = $cl -and $cl.ToLower().Replace('/', '\').Contains($WallProfile) -and $cl -notmatch '--type='
    }
    if ($script:WallCheck.Count -gt 5000) { $script:WallCheck.Clear() }
    $script:WallCheck[$key] = [bool]$wall
  }
  return $script:WallCheck[$key]
}
# No wall window may be on the notebook's own panel (wrong place at launch, opened there from the
# control center, or moved there by Windows when the LED screen went away): it gets WM_CLOSE at
# once, its browser is ended if it is still there 1.5 s later; ours opens again on a second display
# as soon as there is one. Returns $false if ours was on the notebook.
$script:InternalSince = @{}
function Test-WallPlace {
  # only processes with a window on the notebook's panel are looked at
  $ids = @([KinectWandNative]::InternalWindowPids() | Where-Object { $_ -eq $script:WallPid -or (Test-WallBrowser $_) })
  $bad = @()
  if ($ids.Count) { $bad = @([KinectWandNative]::CloseOnInternal([int[]]$ids)) }
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
  if ($script:WallPid) {
    $place = Get-WallPlace $script:WallPid
    if ($place -and -not $place.Internal) { $script:WallScreen = $place }
  }
  return $true
}

function Watch-Components {
  $now = $Clock.Elapsed.TotalSeconds
  # hub
  $script:HubStatus = Get-HubStatus
  if ($script:HubStatus) { $script:HubFails = 0 } else { $script:HubFails++ }
  if (-not $script:HubStatus -and $script:HubFails -ge 3 -and $now -ge $script:NextTry.hub) {
    if (Test-Ours $script:HubOurs) {
      Add-Event 'Kinect-Hub antwortet nicht' 'warn'
    } elseif (-not (Get-NetTCPConnection -LocalPort $Hub -State Listen -ErrorAction SilentlyContinue)) {
      Start-Hub
    } else {
      Add-Event "Port $Hub ist belegt, aber kein Hub antwortet" 'warn'
    }
    $script:NextTry.hub = $now + 15
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
    $found = Find-Wall
    if ($found -and ([string]$found.CommandLine).Contains("--app=$($script:Vite.url)/wall/")) {
      $p = Get-Process -Id ([int]$found.ProcessId) -ErrorAction SilentlyContinue
      if ($p) {
        $script:WallPid = $p.Id; $script:WallStart = Get-StartKey $p; $script:WallUrl = $script:Vite.url
        if (-not ($J.started | Where-Object { $_ -and $_.role -eq 'wall' -and [int]$_.pid -eq $p.Id })) { Add-Event "Das Wand-Fenster ist schon offen (PID $($p.Id)), wird mitbenutzt" }
        [void](Test-WallPlace)
      }
    } else {
      if ($found) { Stop-Tree ([int]$found.ProcessId) -Gentle }   # an old window of another dev server
      Open-Wall
    }
    $script:NextTry.wall = $now + 5
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

if ($script:WallAuto) { Watch-Components }
if (-not $NoControl) { Open-Control }
Update-Tuning

# ---------------------------------------------------------------------------------------------
# status screen and keys

$script:LastCpu = @{}
$script:LastCpuAt = 0.0
$script:TopCpu = ''
$Cores = [Environment]::ProcessorCount
function Update-TopCpu {
  $now = $Clock.Elapsed.TotalSeconds
  $dt = $now - $script:LastCpuAt
  $cur = @{}
  $use = @{}
  foreach ($p in Get-Process) {
    $cpu = $p.CPU
    if ($p.Id -eq 0 -or $null -eq $cpu) { continue }
    $cur[$p.Id] = $cpu
    if ($dt -gt 0 -and $script:LastCpu.ContainsKey($p.Id)) {
      $share = ($cpu - $script:LastCpu[$p.Id]) / $dt / $Cores * 100
      if ($share -gt 0) { $use[$p.ProcessName] = [double]$use[$p.ProcessName] + $share }
    }
  }
  $script:LastCpu = $cur
  $script:LastCpuAt = $now
  $script:TopCpu = ($use.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 |
      ForEach-Object { '{0} {1:0} %' -f $_.Key, $_.Value }) -join ' · '
}

$script:LastLines = 0
function Show-Status {
  $w = [Math]::Max(40, [Console]::WindowWidth - 1)
  $lines = New-Object System.Collections.ArrayList
  function L([string]$text, [string]$color = 'Gray') { [void]$lines.Add(@($text, $color)) }
  $up = $Clock.Elapsed
  if ($script:ConfirmUntil -gt $up.TotalSeconds) {
    L ('  Wirklich beenden? Die Wand geht aus.  [J] ja, andere Taste: nein  ({0:0} s)' -f ($script:ConfirmUntil - $up.TotalSeconds)) 'Yellow'
  }
  L ('  Kinect-Wand · läuft seit {0}:{1:00}:{2:00}' -f [int][Math]::Floor($up.TotalHours), $up.Minutes, $up.Seconds) 'Cyan'
  $busy = (Get-Content -LiteralPath $HotkeyFile -ErrorAction SilentlyContinue) -eq 'busy'
  L ("  NOTAUS: $HotkeyText" + $(if ($busy) { ' ist belegt! Desktop-Symbol ''Kinect-Wand NOTAUS'' nutzen' } else { ' (in jedem Fenster) oder Desktop-Symbol ''Kinect-Wand NOTAUS''' })) 'Red'
  L ''
  $h = $script:HubStatus
  if ($h) {
    $st = [string]$h.sensor.state
    $sensor = switch ($st) { 'streaming' { 'läuft' } 'searching' { 'sucht' } 'starting' { 'startet' } 'offline' { 'aus' } default { $st } }
    if ($h.source -ne 'kinect') { $sensor = "Quelle $($h.source)" }
    $detail = if ($st -ne 'streaming' -and $h.sensor.detail) { " ($($h.sensor.detail))" } else { '' }
    $color = if ($st -eq 'streaming' -and $h.fps -ge 25) { 'Green' } elseif ($st -eq 'streaming') { 'Yellow' } else { 'Red' }
    L ('  Kinect     {0:0.0} fps · Sensor {1}{2} · {3} Personen · Pose {4} {5:0} ms' -f [double]$h.fps, $sensor, $detail, [int]$h.tracking.persons, $h.pose.active, [double]$h.pose.ms) $color
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
  L ('  Schirme    ' + ((@([KinectWandNative]::Displays()) | Sort-Object X | ForEach-Object { Format-Screen $_ }) -join ' · ')) 'DarkGray'
  $cpu = [KinectWandNative]::CpuPercent()
  $power = [KinectWandNative]::Power()
  L ('  Rechner    CPU {0:0} % · RAM frei {1:0.0} GB · {2}' -f [Math]::Max(0, $cpu), [KinectWandNative]::FreeMemoryGB(), $power) $(if ($power -like 'AKKU*') { 'Yellow' } else { 'Gray' })
  L "  Viel CPU   $($script:TopCpu)" 'DarkGray'
  L ''
  if ($script:Optimize) {
    L "  Optimiert  Energieplan · kein Standby/Bildschirm aus · $(Get-TuneSummary)" 'DarkGreen'
    $svc = Read-Json $ServicesFile
    if ($script:AdminState -eq 'an' -and $svc -and -not $svc.restored) {
      $off = @($svc.services | Where-Object { $_.now -eq 'Stopped' } | ForEach-Object { $_.name })
      $lock = @($svc.services | Where-Object { $_.note } | ForEach-Object { $_.name })
      L ("             Dienste angehalten: $(if ($off.Count) { $off -join ', ' } else { '-' })" + $(if ($lock.Count) { " · nicht anhaltbar: $($lock -join ', ')" } else { '' })) 'DarkGreen'
    } elseif ($script:AdminState -eq 'an') { L '             Dienste: warte auf den Admin-Helfer ...' 'DarkGray' }
    else { L '             Dienste: unverändert (ohne Admin)' 'DarkGray' }
  } else {
    L '  Optimiert  nein, zurückgestellt (der Bildschirm bleibt trotzdem an)' 'DarkGray'
  }
  L ''
  L '  [Q] Beenden  [W] Wand-Fenster zu/auf  [S] Steuerzentrale aufs Notebook  [O] Optimierungen zurück  [L] Logs' 'White'
  L ''
  foreach ($e in $Events) { L ('  {0:HH:mm:ss} {1}' -f $e.t, $e.text) $(if ($e.level -eq 'warn') { 'Yellow' } else { 'DarkGray' }) }

  $max = [Math]::Max(5, [Console]::WindowHeight - 1)
  while ($lines.Count -gt $max) { $lines.RemoveAt($lines.Count - 1) }
  try { [Console]::SetCursorPosition(0, 0) } catch { }
  foreach ($l in $lines) {
    $t = [string]$l[0]
    if ($t.Length -gt $w) { $t = $t.Substring(0, $w) }
    Write-Host $t.PadRight($w) -ForegroundColor $l[1]
  }
  for ($i = $lines.Count; $i -lt $script:LastLines; $i++) { Write-Host (' ' * $w) }
  $script:LastLines = $lines.Count
}

function Stop-Optimizing {
  $script:Optimize = $false
  $problems = @(Restore-Power $J)
  Restore-Processes $J
  New-Item -ItemType File -Force $ServicesFlag | Out-Null
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
  $r = Restore-All $J -StopStarted
  [KinectWandNative]::KeepAwake($false)
  New-Item -ItemType File -Force $GuardStopFlag | Out-Null
  $servicesOk = if ($script:AdminState -eq 'an') { Wait-ServicesRestored 30 } else { $true }
  foreach ($p in $r.problems) { Write-Host "  $p" -ForegroundColor Yellow }
  if (-not $servicesOk) { Write-Host '  Die Windows-Dienste laufen spätestens nach dem nächsten Anmelden wieder.' -ForegroundColor Yellow }
  Write-EventLog 'beendet, alles zurückgestellt'
  Write-Host '  Fertig: alles ist wieder wie vorher. (Das Fenster schließt sich gleich.)' -ForegroundColor Green
  Start-Sleep -Seconds 4
}

$script:Drawn = $true
# nothing here may wait for the user: the watchdog runs in this loop
$ConsoleMode = [KinectWandNative]::NoQuickEdit()
try { [Console]::TreatControlCAsInput = $true } catch { }
try { [Console]::CursorVisible = $false } catch { }
Clear-Host
$nextWatch = 0; $nextTune = 10; $nextDraw = 0; $nextCpu = 0; $nextPlace = 0
$script:ConfirmUntil = 0
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
        if ($ch -in 'j', 'y') { $quit = $true; break }
        Add-Event 'Beenden abgebrochen'
      } elseif ($ch -eq 'q' -or ($k.Key -eq 'C' -and ($k.Modifiers -band [ConsoleModifiers]::Control))) {
        $script:ConfirmUntil = $now + 10
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
    if ($now -ge $nextPlace) { [void](Test-WallPlace); $nextPlace = $now + 0.5 }
    if ($now -ge $nextWatch) {
      Watch-Components
      if (-not (Test-Alive $J.guardPid $J.guardStart)) { Add-Event 'Wächter neu gestartet' 'warn'; Start-Guard }
      [KinectWandNative]::KeepAwake($true)
      $nextWatch = $now + 2
    }
    if ($script:ConfirmUntil -and $script:ConfirmUntil -le $now) { $script:ConfirmUntil = 0; $nextDraw = 0 }
    if ($script:Optimize -and $now -ge $nextTune) { Update-Tuning; $nextTune = $now + 20 }
    if ($now -ge $nextCpu) { Update-TopCpu; $nextCpu = $now + 5 }
    if ($now -ge $nextDraw) { Show-Status; $nextDraw = $now + 2 }
  } catch {
    Add-Event "Fehler: $($_.Exception.Message)" 'warn'
    $nextWatch = $now + 2; $nextDraw = $now + 1
  }
  Start-Sleep -Milliseconds 200
}
Invoke-Quit
