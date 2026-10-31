param([Parameter(Mandatory=$true)][ValidateSet('capture','apply','restore')][string]$Action)
$ErrorActionPreference = 'Stop'

# Per-user WinINet proxy management. Reads the current settings first so the
# previous state can be restored later, and refuses to overwrite proxy settings
# that another program changed in the meantime.
$source = @'
using System;
using System.Runtime.InteropServices;

public static class NorthstarWinInetProxy {
  [StructLayout(LayoutKind.Explicit)]
  public struct ValueUnion {
    [FieldOffset(0)] public int Number;
    [FieldOffset(0)] public IntPtr Text;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct Option { public int Id; public ValueUnion Value; }
  [StructLayout(LayoutKind.Sequential)]
  public struct OptionList {
    public IntPtr Connection;
    public int Error;
    public int Count;
    public IntPtr Options;
  }
  [DllImport("wininet.dll", SetLastError=true)]
  static extern bool InternetQueryOption(IntPtr h, int option, ref OptionList list, ref int size);
  [DllImport("wininet.dll", SetLastError=true)]
  static extern bool InternetSetOption(IntPtr h, int option, ref OptionList list, int size);
  [DllImport("wininet.dll")]
  static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int size);
  [DllImport("kernel32.dll")]
  static extern IntPtr GlobalFree(IntPtr memory);

  static readonly int[] Ids = new int[] { 1, 2, 3, 4, 5 };
  const int PerConnectionOption = 75;
  const int SettingsChanged = 39;
  const int Refresh = 37;
  const int DirectAndProxy = 3;

  static int SizeOfOption() { return Marshal.SizeOf(typeof(Option)); }
  static int ReadNumber(IntPtr basePtr, int index) {
    Option o = (Option)Marshal.PtrToStructure(IntPtr.Add(basePtr, index * SizeOfOption()), typeof(Option));
    return o.Value.Number;
  }
  static string ReadText(IntPtr basePtr, int index) {
    Option o = (Option)Marshal.PtrToStructure(IntPtr.Add(basePtr, index * SizeOfOption()), typeof(Option));
    if (o.Value.Text == IntPtr.Zero) return "";
    string value = Marshal.PtrToStringUni(o.Value.Text);
    GlobalFree(o.Value.Text);
    return value ?? "";
  }
  public static object Capture() {
    int optionSize = SizeOfOption();
    IntPtr options = Marshal.AllocHGlobal(optionSize * Ids.Length);
    try {
      for (int i = 0; i < Ids.Length; i++) {
        Option o = new Option(); o.Id = Ids[i];
        Marshal.StructureToPtr(o, IntPtr.Add(options, i * optionSize), false);
      }
      OptionList list = new OptionList(); list.Count = Ids.Length; list.Options = options;
      int bytes = Marshal.SizeOf(typeof(OptionList));
      if (!InternetQueryOption(IntPtr.Zero, PerConnectionOption, ref list, ref bytes))
        throw new InvalidOperationException("Windows could not read the current per-user proxy settings (WinINet error " + Marshal.GetLastWin32Error() + ").");
      return new {
        flags = ReadNumber(options, 0),
        proxyServer = ReadText(options, 1),
        proxyBypass = ReadText(options, 2),
        autoConfigUrl = ReadText(options, 3),
        autoDiscoveryFlags = ReadNumber(options, 4)
      };
    } finally { Marshal.FreeHGlobal(options); }
  }
  static void Set(int flags, string proxy, string bypass, string pac, int autodetect) {
    int optionSize = SizeOfOption();
    IntPtr options = Marshal.AllocHGlobal(optionSize * Ids.Length);
    IntPtr[] strings = new IntPtr[3];
    try {
      strings[0] = Marshal.StringToHGlobalUni(proxy ?? "");
      strings[1] = Marshal.StringToHGlobalUni(bypass ?? "");
      strings[2] = Marshal.StringToHGlobalUni(pac ?? "");
      int[] numbers = new int[] { flags, 0, 0, 0, autodetect };
      for (int i = 0; i < Ids.Length; i++) {
        Option o = new Option(); o.Id = Ids[i];
        if (i == 1) o.Value.Text = strings[0];
        else if (i == 2) o.Value.Text = strings[1];
        else if (i == 3) o.Value.Text = strings[2];
        else o.Value.Number = numbers[i];
        Marshal.StructureToPtr(o, IntPtr.Add(options, i * optionSize), false);
      }
      OptionList list = new OptionList(); list.Count = Ids.Length; list.Options = options;
      if (!InternetSetOption(IntPtr.Zero, PerConnectionOption, ref list, Marshal.SizeOf(typeof(OptionList))))
        throw new InvalidOperationException("Windows could not update the per-user proxy settings (WinINet error " + Marshal.GetLastWin32Error() + ").");
      InternetSetOption(IntPtr.Zero, SettingsChanged, IntPtr.Zero, 0);
      InternetSetOption(IntPtr.Zero, Refresh, IntPtr.Zero, 0);
    } finally {
      Marshal.FreeHGlobal(options);
      foreach (IntPtr p in strings) if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
    }
  }
  public static void Apply(string proxy, string bypass) { Set(DirectAndProxy, proxy, bypass, "", 0); }
  public static void Restore(int flags, string proxy, string bypass, string pac, int autodetect) {
    Set(flags, proxy, bypass, pac, autodetect);
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$inputText = [Console]::In.ReadToEnd()
$inputData = if ($inputText) { $inputText | ConvertFrom-Json } else { $null }
try {
  switch ($Action) {
    'capture' {
      $snapshot = [NorthstarWinInetProxy]::Capture()
      @{ ok = $true; snapshot = $snapshot } | ConvertTo-Json -Compress
    }
    'apply' {
      if (-not $inputData -or -not $inputData.port) { throw 'Missing local HTTP port.' }
      $proxy = "127.0.0.1:$([int]$inputData.port)"
      $bypass = '<local>;localhost;127.0.0.1;[::1]'
      [NorthstarWinInetProxy]::Apply($proxy, $bypass)
      @{ ok = $true; proxyServer = $proxy; proxyBypass = $bypass } | ConvertTo-Json -Compress
    }
    'restore' {
      if (-not $inputData -or -not $inputData.snapshot) { throw 'Missing saved proxy snapshot.' }
      $current = [NorthstarWinInetProxy]::Capture()
      if ([int]$current.flags -ne 3 -or [string]$current.proxyServer -ne [string]$inputData.appliedProxyServer -or [string]$current.proxyBypass -ne [string]$inputData.appliedProxyBypass) {
        @{ ok = $true; restored = $false; reason = 'System proxy settings changed outside Northstar; left them untouched.' } | ConvertTo-Json -Compress
      } else {
        $s = $inputData.snapshot
        [NorthstarWinInetProxy]::Restore([int]$s.flags, [string]$s.proxyServer, [string]$s.proxyBypass, [string]$s.autoConfigUrl, [int]$s.autoDiscoveryFlags)
        @{ ok = $true; restored = $true } | ConvertTo-Json -Compress
      }
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}