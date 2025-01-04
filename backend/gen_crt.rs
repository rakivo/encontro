mod paths;
use {
    paths::*,
    std::{path::Path, fs::{write, create_dir_all}},
    rcgen::{CertifiedKey, generate_simple_self_signed}
};

fn main() -> Result<(), Box::<dyn std::error::Error>> {
    let CertifiedKey { cert, key_pair } = generate_simple_self_signed(vec![
        "127.0.0.1".to_owned(), "localhost".to_owned()
    ]).unwrap();

    if !Path::new(CERTS_DIR).exists() {
        create_dir_all(CERTS_DIR).expect("could not certs directory")
    }

    write(CERT_FILE, cert.pem())?;
    write(KEY_FILE, key_pair.serialize_pem())?;

    Ok(())
}
