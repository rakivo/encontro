use std::path::Path;

fn main() {
    if !Path::new("./certs/key.pem").exists() || !Path::new("./certs/cert.pem").exists() {
        panic!("\nIMPORTANT MESSAGE: run `bash ./gen_crt.sh` first\n")
    }
}
