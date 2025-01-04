/*
    I created this module so I can import it both in `build.rs`, which is executed at pre-compile stage, and `main.rs` to import the generated certificates if needed.
*/

macro_rules! define_key_cert {
    (
        const CERTS_DIR: &str = $certs_dir: literal;
        const KEY_FILE: $key_ty: ty = $key_path: literal;
        const CERT_FILE: $cert_ty: ty = $cert_path: literal;
    ) => {
        #[allow(unused)] pub(crate) const CERTS_DIR: &str = $certs_dir;
        #[allow(unused)] pub(crate) const KEY_FILE:  $key_ty = concat!($certs_dir, $key_path);
        #[allow(unused)] pub(crate) const CERT_FILE: $cert_ty = concat!($certs_dir, $cert_path);
    };
}

define_key_cert! {
    const CERTS_DIR: &str = "./certs/";
    const KEY_FILE:  &str = "key.pem";
    const CERT_FILE: &str = "cert.pem";
}
