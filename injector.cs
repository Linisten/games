using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace CouchPlayInjector
{
    class Program
    {
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT
        {
            public uint type;
            public InputUnion u;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        const uint INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const uint KEYEVENTF_SCANCODE = 0x0008;

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        static extern uint MapVirtualKey(uint uCode, uint uMapType);

        static void Main(string[] args)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.WriteLine("COUCHPLAY_INJECTOR_READY");

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;
                if (line == "PING") { Console.WriteLine("PONG"); continue; }
                if (line == "EXIT") break;

                // Format: KEY <VK_CODE> <DOWN/UP>
                // Example: KEY 38 DOWN  (ArrowUp down)
                // Example: KEY 38 UP    (ArrowUp up)
                string[] parts = line.Split(' ');
                if (parts.Length >= 3 && parts[0] == "KEY")
                {
                    ushort vk;
                    if (ushort.TryParse(parts[1], out vk))
                    {
                        bool isDown = parts[2].ToUpper() == "DOWN";
                        SendKey(vk, isDown);
                    }
                }
            }
        }

        static void SendKey(ushort vk, bool isDown)
        {
            uint scanCode = MapVirtualKey(vk, 0); // MAPVK_VK_TO_VSC

            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = vk;
            inputs[0].u.ki.wScan = (ushort)scanCode;
            inputs[0].u.ki.time = 0;
            inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;

            uint flags = KEYEVENTF_SCANCODE;

            // Extended keys (Arrow keys, Numpad, Insert, Delete, etc.)
            if (vk >= 33 && vk <= 46)
            {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }

            if (!isDown)
            {
                flags |= KEYEVENTF_KEYUP;
            }

            inputs[0].u.ki.dwFlags = flags;

            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
    }
}
