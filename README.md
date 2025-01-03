# `encontro`

# Quick start
```console
$ cargo run --release
$ firefox https://localhost:8443
```

# Disable the `not secure` warning
> - First, compile the project with `gen_crt` feature, you can do that with `cargo run --release --features=gen_crt`
> - Run `bash gen_crt.sh` to generate self-signed certs.
> - Import those generated certs into your browser, the warning, finally, will be disabled.
