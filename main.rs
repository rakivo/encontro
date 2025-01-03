use std::sync::Arc;
use std::collections::HashMap;
use std::sync::atomic::{Ordering, AtomicUsize};

use actix_files::Files;
use tokio::sync::RwLock;
use rcgen::CertifiedKey;
use actix_web_actors::ws;
use rustls::ServerConfig;
use actix::{Actor, Handler, Message, Recipient, ActorContext, AsyncContext, StreamHandler};
use actix_web::{get, App, Error, HttpRequest, HttpResponse, HttpServer, web::{Data, Payload}};

static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

type Conns = HashMap::<usize, WsConn>;
type AtomicConns = Arc::<RwLock::<Conns>>;

struct WsConn {
    id: usize,
    addr: Recipient::<Broadcast>
}

struct WsActor {
    id: usize,
    conns: Data::<AtomicConns>
}

#[derive(Message)]
#[rtype(result = "()")]
struct Broadcast(String);

impl Actor for WsActor {
    type Context = ws::WebsocketContext::<Self>;

    #[inline]
    fn started(&mut self, ctx: &mut Self::Context) {
        let addr = ctx.address().recipient();
        let conn = WsConn { id: self.id, addr };
        actix::spawn({
            let conns = Data::clone(&self.conns);
            async move {
                let mut conns = conns.write().await;
                conns.insert(conn.id, conn);
            }
        });
    }

    #[inline]
    fn stopped(&mut self, _: &mut Self::Context) {
        actix::spawn({
            let id = self.id;
            let conns = Data::clone(&self.conns);
            async move {
                let mut conns = conns.write().await;
                conns.remove(&id);
            }
        });
    }
}

impl StreamHandler::<Result<ws::Message, ws::ProtocolError>> for WsActor {
    fn handle(&mut self, msg: Result::<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Text(text)) => {
                let src_id = self.id;
                let conns = Data::clone(&self.conns);
                actix::spawn(async move {
                    let conns = conns.read().await;
                    conns.iter().filter(|(id, ..)| **id != src_id).for_each(|(.., conn)| {
                        _ = conn.addr.do_send(Broadcast(text.to_string()))
                    })
                });
            }
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop()
            }
            _ => {}
        }
    }
}

impl Handler<Broadcast> for WsActor {
    type Result = ();

    #[inline]
    fn handle(&mut self, msg: Broadcast, ctx: &mut Self::Context) {
        ctx.text(msg.0)
    }
}

#[inline]
#[get("/ws/")]
async fn ws_route(rq: HttpRequest, stream: Payload, conns: Data::<AtomicConns>) -> Result::<HttpResponse, Error> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    ws::start(WsActor { id, conns }, &rq, stream)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let CertifiedKey { cert, key_pair } = rcgen::generate_simple_self_signed(vec![
        "127.0.0.1".to_owned(), "localhost".to_owned()
    ]).unwrap();

    let key = rustls::PrivateKey(key_pair.serialize_der());
    let cert_chain = rustls::Certificate(cert.der().to_vec());

    let cfg = ServerConfig::builder()
        .with_safe_defaults()
        .with_no_client_auth()
        .with_single_cert(vec![cert_chain], key)
        .expect("failed to create server config");

    let conns = Arc::new(RwLock::new(Conns::new()));

    println!("starting server at <https://localhost:8443>");
    println!("please note:");
    println!("  * Note the HTTPS in the URL; there is no HTTP -> HTTPS redirect.");
    println!("  * You'll need to accept the invalid TLS certificate as it is self-signed.");
    println!("  * Some browsers or OSs may not allow the webcam to be used by multiple pages at once.");

    HttpServer::new(move || {
        App::new()
            .service(ws_route)
            .app_data(Data::new(Arc::clone(&conns)))
            .service(Files::new("/", ".").index_file("index.html"))
    }).bind_rustls_021("0.0.0.0:8443", cfg)?.run().await
}
