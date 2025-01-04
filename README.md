# `encontro`

# Quick start
```console
$ cargo run --release
$ firefox https://localhost:8443
```

# Disable the `not secure` warning
> - First, run `cargo run --bin generate_certs --features=gen_crt` to generate self-signed certificates
> - Then just import those certificates from `certs` directory into your browser, and that is it!
