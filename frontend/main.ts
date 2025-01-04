// @ts-ignore
type PeerConnection = {
  displayName: string;
  pc: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  videoDecoder?: VideoDecoder;
};

let videoEncoder: VideoEncoder | null = null;
let serverConnection: WebSocket | null = null;
let peerConnections: Record<string, PeerConnection> = {};
let localUuid: string, localDisplayName: string, localStream: MediaStream;

const WS_PORT = 8443;
const PEER_CONNECTION_CFG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  },
  audio: false,
};

const ENCODER_CFG: VideoEncoderConfig = {
  codec: 'vp8',
  width: 1280,
  height: 720,
  framerate: 30,
  bitrate: 1_000_000,
  latencyMode: 'realtime',
};

const DECODER_CFG: VideoDecoderConfig = {
  codec: ENCODER_CFG.codec,
  codedWidth: ENCODER_CFG.width,
  codedHeight: ENCODER_CFG.height,
  hardwareAcceleration: "no-preference",
};

async function initializeCodecs(stream: MediaStream): Promise<void> {
  if (!('VideoEncoder' in window)) return;

  const videoTrack = stream.getVideoTracks()[0];
  const trackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
  const frameReader = trackProcessor.readable.getReader();

  videoEncoder = new VideoEncoder({
    output: (encodedChunk: EncodedVideoChunk) => {
      const data = new ArrayBuffer(encodedChunk.byteLength);
      const view = new Uint8Array(data);
      encodedChunk.copyTo(view);

      Object.values(peerConnections).forEach((peer) => {
        if (peer.dataChannel?.readyState === 'open') {
          peer.dataChannel.send(JSON.stringify({
            type: encodedChunk.type,
            timestamp: encodedChunk.timestamp,
            duration: encodedChunk.duration,
          }));
          peer.dataChannel.send(data);
        }
      });
    },
    error: (e) => console.error(e),
  });

  videoEncoder.configure(ENCODER_CFG);

  const processFrames = async () => {
    try {
      while (true) {
        const { value: frame, done } = await frameReader.read();
        if (done) break;
        if (videoEncoder?.state === 'configured') {
          videoEncoder?.encode(frame!);
        }
        frame!.close();
      }
    } catch (e) {
      console.error('Error processing frames:', e);
    }
  };

  processFrames();
}

async function start(): Promise<void> {
  localUuid = createUUID();
  const urlParams = new URLSearchParams(window.location.search);
  localDisplayName = urlParams.get("displayName") || localUuid;

  const labelContainer = document.getElementById("localVideoContainer");
  if (labelContainer) labelContainer.appendChild(makeLabel(localDisplayName));

  try {
    localStream = await getMediaStream();

    const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
    localVideo.srcObject = localStream;

    await initializeCodecs(localStream);

    serverConnection = new WebSocket(`wss://${location.hostname}:${WS_PORT}/ws/`);
    serverConnection.onmessage = (msg) => gotMessageFromServer(msg);
    serverConnection.onopen = () => {
      serverConnection!.send(
        JSON.stringify({ displayName: localDisplayName, uuid: localUuid, dest: "all" })
      );
    };
  } catch (error) {
    errorHandler(error);
  }
}

async function getMediaStream(): Promise<MediaStream> {
  if (navigator.mediaDevices.getDisplayMedia) {
    return await navigator.mediaDevices.getDisplayMedia(CONSTRAINTS);
  } else if (navigator.mediaDevices.getUserMedia) {
    return await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
  } else {
    alert("Your browser does not support getDisplayMedia or getUserMedia API");
    throw new Error("Unsupported media API");
  }
}

function setUpPeer(peerUuid: string, displayName: string, initCall = false): void {
  const peerConnection: PeerConnection = {
    displayName,
    pc: new RTCPeerConnection(PEER_CONNECTION_CFG),
  };

  const dataChannel = peerConnection.pc.createDataChannel('video-channel');
  peerConnection.dataChannel = dataChannel;

  let writable: WritableStreamDefaultWriter<VideoFrame> | undefined;
  let mediaStreamGenerator: MediaStreamTrackGenerator<VideoFrame> | undefined;
  let metadata: any;

  dataChannel.onopen = async () => {
    if (!('VideoDecoder' in window)) return;

    peerConnection.videoDecoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (!mediaStreamGenerator) {
          mediaStreamGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
          writable = mediaStreamGenerator.writable.getWriter();

          const stream = new MediaStream([mediaStreamGenerator]);
          const vidElement = document.querySelector(`#remoteVideo_${peerUuid} video`) as HTMLVideoElement;
          if (vidElement) vidElement.srcObject = stream;
        }
        writable!.write(frame);
      },
      error: (e) => console.error(e),
    });

    peerConnection.videoDecoder.configure(DECODER_CFG);
  };

  dataChannel.onmessage = async (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      metadata = JSON.parse(event.data);
    } else {
      const chunk = new EncodedVideoChunk({
        type: metadata.type,
        timestamp: metadata.timestamp,
        duration: metadata.duration,
        data: event.data,
      });

      if (peerConnection.videoDecoder?.state === 'configured') {
        peerConnection.videoDecoder.decode(chunk);
      }
    }
  };

  peerConnection.pc.ontrack = (event) => gotRemoteStream(event, peerUuid);
  peerConnection.pc.onicecandidate = (event) => gotIceCandidate(event, peerUuid);
  peerConnection.pc.oniceconnectionstatechange = () => checkPeerDisconnect(peerUuid);
  localStream.getTracks().forEach(track => {
    peerConnection.pc.addTrack(track, localStream);
  });
  peerConnections[peerUuid] = peerConnection;

  if (initCall) {
    peerConnection.pc.createOffer()
      .then((description) => createdDescription(description, peerUuid))
      .catch(errorHandler);
  }
}

function gotMessageFromServer(message: MessageEvent): void {
  const signal = JSON.parse(message.data);
  const peerUuid = signal.uuid;

  if (peerUuid === localUuid || (signal.dest !== localUuid && signal.dest !== "all")) return;

  if (signal.type === "peer-disconnect") {
    handlePeerDisconnect(peerUuid);
    return;
  }

  if (signal.displayName && signal.dest === "all") {
    setUpPeer(peerUuid, signal.displayName);
    serverConnection!.send(
      JSON.stringify({ displayName: localDisplayName, uuid: localUuid, dest: peerUuid })
    );
  } else if (signal.displayName && signal.dest === localUuid) {
    setUpPeer(peerUuid, signal.displayName, true);
  } else if (signal.sdp) {
    handleSdpSignal(signal, peerUuid);
  } else if (signal.ice) {
    handleIceCandidate(signal, peerUuid);
  }
}

function handleSdpSignal(signal: any, peerUuid: string): void {
  peerConnections[peerUuid].pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
    .then(() => {
      if (signal.sdp.type === "offer") {
        peerConnections[peerUuid].pc.createAnswer()
          .then((description) => createdDescription(description, peerUuid))
          .catch(errorHandler);
      }
    })
    .catch(errorHandler);
}

function handleIceCandidate(signal: any, peerUuid: string): void {
  peerConnections[peerUuid].pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
}

function handlePeerDisconnect(peerUuid: string): void {
  console.log(`Peer ${peerUuid} disconnected`);
  delete peerConnections[peerUuid];
  const vidElement = document.getElementById(`remoteVideo_${peerUuid}`);
  if (vidElement) document.getElementById("videos")?.removeChild(vidElement);
  updateLayout();
}

function gotRemoteStream(event: RTCTrackEvent, peerUuid: string): void {
  const vidElement = document.createElement("video");
  vidElement.setAttribute("autoplay", "");
  vidElement.setAttribute("muted", "");
  vidElement.srcObject = event.streams[0];

  const vidContainer = document.createElement("div");
  vidContainer.id = `remoteVideo_${peerUuid}`;
  vidContainer.className = "videoContainer";
  vidContainer.appendChild(vidElement);
  vidContainer.appendChild(makeLabel(peerConnections[peerUuid].displayName));

  document.getElementById("videos")?.appendChild(vidContainer);
  updateLayout();
}

function checkPeerDisconnect(peerUuid: string): void {
  const state = peerConnections[peerUuid].pc.iceConnectionState;
  if (["failed", "closed", "disconnected"].includes(state)) {
    handlePeerDisconnect(peerUuid);
  }
}

function gotIceCandidate(event: RTCPeerConnectionIceEvent, peerUuid: string): void {
  if (event.candidate) {
    serverConnection!.send(
      JSON.stringify({ ice: event.candidate, uuid: localUuid, dest: peerUuid })
    );
  }
}

function createdDescription(description: RTCSessionDescriptionInit, peerUuid: string): void {
  peerConnections[peerUuid].pc.setLocalDescription(description)
    .then(() => {
      serverConnection!.send(
        JSON.stringify({
          sdp: peerConnections[peerUuid].pc.localDescription,
          uuid: localUuid,
          dest: peerUuid,
        })
      );
    })
    .catch(errorHandler);
}

function updateLayout(): void {
  const numVideos = Object.keys(peerConnections).length + 1;
  const rowHeight = numVideos > 1 && numVideos <= 4 ? "48vh" : numVideos > 4 ? "32vh" : "98vh";
  const colWidth = numVideos > 1 && numVideos <= 4 ? "48vw" : numVideos > 4 ? "32vw" : "98vw";
  document.documentElement.style.setProperty("--rowHeight", rowHeight);
  document.documentElement.style.setProperty("--colWidth", colWidth);
}

function makeLabel(label: string): HTMLElement {
  const vidLabel = document.createElement("div");
  vidLabel.textContent = label;
  vidLabel.className = "videoLabel";
  return vidLabel;
}

function createUUID(): string {
  return ([1e7, -1e3, -4e3, -8e3, -1e11].join('')).replace(/[018]/g, (c: string) =>
    (parseInt(c, 16) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (parseInt(c, 16) / 4)))).toString(16)
  );
}

function errorHandler(error: any): void {
  console.error(error);
}

window.addEventListener("beforeunload", () => {
  if (videoEncoder?.state !== 'closed') {
    videoEncoder?.close();
  }

  Object.values(peerConnections).forEach(peer => {
    if (peer.videoDecoder?.state !== 'closed') {
      peer.videoDecoder?.close();
    }
    if (peer.dataChannel) {
      peer.dataChannel.close();
    }
  });

  serverConnection?.send(JSON.stringify({
    type: "peer-disconnect",
    uuid: localUuid
  }));
});
