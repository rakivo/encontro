# `encontro`

# Quick start
```console
$ cargo run --release
$ firefox https://localhost:8443
```

# Disabling the `not secure` warning
> - First, run `cargo run --bin generate_certs --features=gen_crt` to generate self-signed certificates
> - Then just import those certificates from `certs` directory into your browser, and you are good to go.

# For those who want to contribute
> # frontend
> - Go to the frontend directory:
```console
cd frontend
```
> - Install typescript and some additional types:
```console
npm i
```
> - Compile the code:
```console
npx tsc --project tsconfig.json
```

> # backend
> - Getting started with the backend is simple. Just run the usual `cargo build` and that is it.
