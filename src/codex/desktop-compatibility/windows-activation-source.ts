// Kept inline so source and standalone Bun distributions carry the same COM adapter.
export const WINDOWS_ACTIVATION_SOURCE = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;

// Windows.Launch preserves package identity and forwards explicit application arguments.
public static class OpenCodexPackageActivation {
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
        [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appId, IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
        [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appId, IntPtr items, out uint processId);
    }
    [DllImport("ole32.dll", PreserveSig=true)]
    private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IApplicationActivationManager manager);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    private static IApplicationActivationManager Manager() {
        var clsid=new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
        var iid=new Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D");
        IApplicationActivationManager manager;
        // LOCAL_SERVER preserves activation argument lifetime after the short launcher exits.
        Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid,IntPtr.Zero,4,ref iid,out manager));
        return manager;
    }
    public static void ValidateActivationService() {var manager=Manager();Marshal.FinalReleaseComObject(manager);}
    public static uint Activate(string appId,string arguments) {
        var manager=Manager();
        try {uint pid;Marshal.ThrowExceptionForHR(manager.ActivateApplication(appId,arguments,0,out pid));return pid;}
        finally {Marshal.FinalReleaseComObject(manager);}
    }
    public static string PackageOf(uint pid) {
        var handle=OpenProcess(0x1000,false,pid);
        if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {uint length=0;int status=GetPackageFullName(handle,ref length,null);
            if(status==15700)return null;
            if(status!=122)throw new System.ComponentModel.Win32Exception(status);
            var value=new StringBuilder((int)length);status=GetPackageFullName(handle,ref length,value);
            if(status!=0)throw new System.ComponentModel.Win32Exception(status);
            return value.ToString();
        }finally{CloseHandle(handle);}
    }
}`;
