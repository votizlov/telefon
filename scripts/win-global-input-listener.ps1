$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class WinGlobalInputListener
{
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    private static readonly HookProc KeyboardProc = KeyboardHookCallback;
    private static readonly HookProc MouseProc = MouseHookCallback;
    private static IntPtr _keyboardHook = IntPtr.Zero;
    private static IntPtr _mouseHook = IntPtr.Zero;

    public static void Run()
    {
        _keyboardHook = SetHook(13, KeyboardProc);
        _mouseHook = SetHook(14, MouseProc);
        AppDomain.CurrentDomain.ProcessExit += (_, __) => Cleanup();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            Application.ExitThread();
        };
        Application.Run();
        Cleanup();
    }

    private static IntPtr SetHook(int hookId, HookProc proc)
    {
        using (Process currentProcess = Process.GetCurrentProcess())
        using (ProcessModule currentModule = currentProcess.MainModule)
        {
            return SetWindowsHookEx(hookId, proc, GetModuleHandle(currentModule.ModuleName), 0);
        }
    }

    private static void Cleanup()
    {
        if (_keyboardHook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_keyboardHook);
            _keyboardHook = IntPtr.Zero;
        }

        if (_mouseHook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_mouseHook);
            _mouseHook = IntPtr.Zero;
        }
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            bool isDown = message == 0x0100 || message == 0x0104;
            bool isUp = message == 0x0101 || message == 0x0105;

            if (isDown || isUp)
            {
                KbdLlHookStruct data = Marshal.PtrToStructure<KbdLlHookStruct>(lParam);
                string name = MapKeyboardKey(data.vkCode);
                if (!string.IsNullOrEmpty(name))
                {
                    Emit(isDown, name);
                }
            }
        }

        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            string name = null;
            bool isDown = false;
            bool shouldEmit = true;

            switch (message)
            {
                case 0x0201:
                    name = "MOUSE LEFT";
                    isDown = true;
                    break;
                case 0x0202:
                    name = "MOUSE LEFT";
                    break;
                case 0x0204:
                    name = "MOUSE RIGHT";
                    isDown = true;
                    break;
                case 0x0205:
                    name = "MOUSE RIGHT";
                    break;
                case 0x0207:
                    name = "MOUSE MIDDLE";
                    isDown = true;
                    break;
                case 0x0208:
                    name = "MOUSE MIDDLE";
                    break;
                case 0x020B:
                case 0x020C:
                    MsLlHookStruct data = Marshal.PtrToStructure<MsLlHookStruct>(lParam);
                    int xButton = (data.mouseData >> 16) & 0xFFFF;
                    name = xButton == 1 ? "MOUSE X1" : "MOUSE X2";
                    isDown = message == 0x020B;
                    break;
                default:
                    shouldEmit = false;
                    break;
            }

            if (shouldEmit && !string.IsNullOrEmpty(name))
            {
                Emit(isDown, name);
            }
        }

        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static void Emit(bool isDown, string name)
    {
        Console.Out.WriteLine((isDown ? "DOWN" : "UP") + "|" + name);
        Console.Out.Flush();
    }

    private static string MapKeyboardKey(int vkCode)
    {
        if (vkCode >= 0x30 && vkCode <= 0x39)
        {
            return ((char)vkCode).ToString();
        }

        if (vkCode >= 0x41 && vkCode <= 0x5A)
        {
            return ((char)vkCode).ToString();
        }

        if (vkCode >= 0x70 && vkCode <= 0x7B)
        {
            return "F" + (vkCode - 0x6F);
        }

        switch (vkCode)
        {
            case 0x08:
                return "BACKSPACE";
            case 0x09:
                return "TAB";
            case 0x0D:
                return "RETURN";
            case 0x10:
                return "SHIFT";
            case 0x11:
                return "CTRL";
            case 0x12:
                return "ALT";
            case 0x1B:
                return "ESCAPE";
            case 0x20:
                return "SPACE";
            case 0x25:
                return "LEFT";
            case 0x26:
                return "UP";
            case 0x27:
                return "RIGHT";
            case 0x28:
                return "DOWN";
            case 0x2E:
                return "DELETE";
            case 0x5B:
            case 0x5C:
                return "META";
            default:
                return null;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KbdLlHookStruct
    {
        public int vkCode;
        public int scanCode;
        public int flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MsLlHookStruct
    {
        public Point pt;
        public int mouseData;
        public int flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
}
"@

[WinGlobalInputListener]::Run()
