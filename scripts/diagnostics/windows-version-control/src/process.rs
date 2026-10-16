use serde_json::{Value, json};
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::{FILETIME, WAIT_TIMEOUT},
    System::{
        ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
        },
        Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SYNCHRONIZE,
            PROCESS_VM_READ, QueryFullProcessImageNameW, WaitForSingleObject,
        },
    },
};

fn times(handle: windows_sys::Win32::Foundation::HANDLE) -> io::Result<(u64, u64)> {
    let (mut born, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    if unsafe { GetProcessTimes(handle, &mut born, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let ticks =
        |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    Ok((ticks(born), ticks(kernel) + ticks(user)))
}

pub struct Process {
    handle: OwnedHandle,
    pub born: u64,
}

impl Process {
    pub fn open(pid: u32) -> io::Result<Self> {
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let born = times(raw)?.0;
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(raw, 0, path.as_mut_ptr(), &mut length) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if !String::from_utf16_lossy(&path[..length as usize])
            .to_ascii_lowercase()
            .ends_with("\\bun.exe")
        {
            return Err(io::Error::other("refusing non-Bun target"));
        }
        Ok(Self { handle, born })
    }

    pub fn live(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) == WAIT_TIMEOUT }
    }

    pub fn metrics(&self) -> Value {
        let mut memory = PROCESS_MEMORY_COUNTERS_EX {
            cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        if unsafe {
            GetProcessMemoryInfo(
                self.handle.as_raw_handle(),
                (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
                size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            )
        } == 0
        {
            return json!({"metrics_unavailable": true});
        }
        json!({"private_bytes":memory.PrivateUsage,"working_set":memory.WorkingSetSize,
            "cpu_100ns":times(self.handle.as_raw_handle()).ok().map(|value|value.1)})
    }
}
