#![deny(unsafe_op_in_unsafe_fn)]

mod protocol;
mod sandbox;

use std::io::{self, Read, Write};

use protocol::{HelperRequest, HelperResponse, MAX_REQUEST_BYTES, PROTOCOL_VERSION};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("__probe-child") {
        std::process::exit(sandbox::run_probe_child());
    }

    let response = match read_request().and_then(handle_request) {
        Ok(response) => response,
        Err(error) => HelperResponse::error(error),
    };
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &response).is_err() || stdout.write_all(b"\n").is_err() {
        std::process::exit(2);
    }
}

fn read_request() -> Result<HelperRequest, String> {
    let mut body = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| "could not read helper request".to_owned())?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err("helper request exceeds its size limit".to_owned());
    }
    let request: HelperRequest =
        serde_json::from_slice(&body).map_err(|_| "helper request is invalid".to_owned())?;
    request.validate()?;
    Ok(request)
}

fn handle_request(request: HelperRequest) -> Result<HelperResponse, String> {
    if request.version != PROTOCOL_VERSION {
        return Err("unsupported helper protocol version".to_owned());
    }
    match request.operation.as_str() {
        "probe" => sandbox::probe().map(|()| HelperResponse::probe_success()),
        "run" => sandbox::run(&request).map(HelperResponse::command_success),
        _ => Err("unsupported helper operation".to_owned()),
    }
}
