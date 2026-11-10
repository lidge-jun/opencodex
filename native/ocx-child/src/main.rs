#![deny(unsafe_op_in_unsafe_fn)]

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = ocx_child::cli::run_cli(&args);
    ExitCode::from(code)
}
