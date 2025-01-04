let peerConnections = {};
let videoEncoder, videoDecoder;
let localUuid, localDisplayName, localStream, serverConnection;

const WS_PORT = 8443;
const PEER_CONNECTION_CFG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const CONSTRAINTS = {
  video: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 }
  },
  audio: false
};

const ENCODER_CONFIG = {
  codec: 'vp8',
  vp8: {
    bitrate: 1_000_000,
    frameRate: 30,
    keyFrameInterval: 20,
  },

  width: 1280,
  height: 720,
  framerate: 30,
  bitrate: 1_000_000,
  latencyMode: 'realtime',
};

const DECODER_CONFIG = {
  codec: ENCODER_CONFIG.codec,
  width: ENCODER_CONFIG.width,
  height: ENCODER_CONFIG.height,
  framerate: ENCODER_CONFIG.framerate
};

async function initializeCodecs(stream) {
  if (!('VideoEncoder' in window)) return;

  const videoTrack = stream.getVideoTracks()[0];
  const trackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
  const frameReader = trackProcessor.readable.getReader();

  videoEncoder = new VideoEncoder({
    output: encodedChunk => {
      const data = new ArrayBuffer(encodedChunk.byteLength);
      const view = new Uint8Array(data);
      encodedChunk.copyTo(view);

      Object.values(peerConnections).forEach(peer => {
        if (peer.dataChannel?.readyState === 'open') {
          peer.dataChannel.send(JSON.stringify({
            type: encodedChunk.type,
            timestamp: encodedChunk.timestamp,
            duration: encodedChunk.duration
          }));
          peer.dataChannel.send(data);
        }
      });
    },
    error: e => console.error(e)
  });

  await videoEncoder.configure(ENCODER_CONFIG);

  const processFrames = async () => {
    try {
      while (true) {
        const { value: frame, done } = await frameReader.read();
        if (done) break;
        if (videoEncoder.state === 'configured') {
          videoEncoder.encode(frame);
        }
        frame.close();
      }
    } catch (e) {
      console.error('Error processing frames:', e);
    }
  };

  processFrames();
}

async function start() {
  localUuid = createUUID();

  const urlParams = new URLSearchParams(window.location.search);
  localDisplayName = urlParams.get("displayName") || localUuid;

  document.getElementById("localVideoContainer").appendChild(makeLabel(localDisplayName));

  try {
    let stream;

    if (navigator.mediaDevices.getDisplayMedia) {
      stream = await navigator.mediaDevices.getDisplayMedia(CONSTRAINTS);
    } else if (navigator.mediaDevices.getUserMedia) {
      stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    } else {
      alert("Your browser does not support neither getDisplayMedia or getUserMedia API");
      return;
    }

    localStream = stream;

    const localVideo = document.getElementById("localVideo");
    localVideo.srcObject = stream;
    
    await initializeCodecs(stream);

    serverConnection = new WebSocket(`wss://${location.hostname}:${WS_PORT}/ws/`);
    serverConnection.onmessage = gotMessageFromServer;
    serverConnection.onopen = () => {
      serverConnection.send(JSON.stringify({
        displayName: localDisplayName,
        uuid: localUuid,
        dest: "all",
      }));
    };
  } catch (error) {
    errorHandler(error);
  }
}

function setUpPeer(peerUuid, displayName, initCall = false) {
  peerConnections[peerUuid] = {
    displayName,
    pc: new RTCPeerConnection(PEER_CONNECTION_CFG),
  };

  const dataChannel = peerConnections[peerUuid].pc.createDataChannel('video-channel');
  peerConnections[peerUuid].dataChannel = dataChannel;
  
  let writable;
  let metadata;
  let mediaStreamGenerator;
  let chunksData = new Uint8Array();

  dataChannel.onopen = async () => {
    if (!('VideoDecoder' in window)) return;

    peerConnections[peerUuid].videoDecoder = new VideoDecoder({
      output: frame => {
        if (!mediaStreamGenerator) {
          mediaStreamGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
          writable = mediaStreamGenerator.writable.getWriter();
          
          const stream = new MediaStream([mediaStreamGenerator]);
          const vidElement = document.querySelector(`#remoteVideo_${peerUuid} video`);
          if (vidElement) {
            vidElement.srcObject = stream;
          }
        }
        writable.write(frame);
      },
      error: e => console.error(e)
    });

    await peerConnections[peerUuid].videoDecoder.configure(DECODER_CONFIG);
  };

  dataChannel.onmessage = async event => {
    if (typeof event.data === 'string') {
      metadata = JSON.parse(event.data);
    } else {
      const chunk = new EncodedVideoChunk({
        type: metadata.type,
        timestamp: metadata.timestamp,
        duration: metadata.duration,
        data: event.data
      });

      if (peerConnections[peerUuid].videoDecoder?.state === 'configured') {
        peerConnections[peerUuid].videoDecoder.decode(chunk);
      }
    }
  };

  peerConnections[peerUuid].pc.ontrack = (event) => gotRemoteStream(event, peerUuid);
  peerConnections[peerUuid].pc.onicecandidate = (event) => gotIceCandidate(event, peerUuid);
  peerConnections[peerUuid].pc.oniceconnectionstatechange = (event) => checkPeerDisconnect(event, peerUuid);
  peerConnections[peerUuid].pc.addStream(localStream);

  if (initCall) {
    peerConnections[peerUuid].pc
      .createOffer()
      .then((description) => createdDescription(description, peerUuid))
      .catch(errorHandler);
  }
}

function gotMessageFromServer(message) {
  const signal = JSON.parse(message.data);
  const peerUuid = signal.uuid;

  if (peerUuid === localUuid || (signal.dest !== localUuid && signal.dest !== "all")) return;

  if (signal.type === "peer-disconnect") {
    if (peerConnections[peerUuid]) {
      console.log(`Peer ${peerUuid} disconnected`);
      delete peerConnections[peerUuid];
      document.getElementById('videos').removeChild(document.getElementById('remoteVideo_' + peerUuid));
      updateLayout();
    }
    return;
  }

  if (signal.displayName && signal.dest === "all") {
    setUpPeer(peerUuid, signal.displayName);
    serverConnection.send(JSON.stringify({
      displayName: localDisplayName,
      uuid: localUuid,
      dest: peerUuid,
    }));
  } else if (signal.displayName && signal.dest === localUuid) {
    setUpPeer(peerUuid, signal.displayName, true);
  } else if (signal.sdp) {
    peerConnections[peerUuid].pc
      .setRemoteDescription(new RTCSessionDescription(signal.sdp))
      .then(() => {
        if (signal.sdp.type === "offer") {
          peerConnections[peerUuid].pc
            .createAnswer()
            .then((description) => createdDescription(description, peerUuid))
            .catch(errorHandler);
        }
      }).catch(errorHandler);
  } else if (signal.ice) {
    peerConnections[peerUuid].pc
      .addIceCandidate(new RTCIceCandidate(signal.ice))
      .catch(errorHandler);
  }
}

function gotRemoteStream(event, peerUuid) {
  const vidElement = document.createElement("video");
  vidElement.setAttribute("autoplay", "");
  vidElement.setAttribute("muted", "");
  vidElement.srcObject = event.streams[0];

  const vidContainer = document.createElement("div");
  vidContainer.setAttribute("id", `remoteVideo_${peerUuid}`);
  vidContainer.setAttribute("class", "videoContainer");
  vidContainer.appendChild(vidElement);
  vidContainer.appendChild(makeLabel(peerConnections[peerUuid].displayName));

  document.getElementById("videos").appendChild(vidContainer);
  updateLayout();
}

function checkPeerDisconnect(event, peerUuid) {
  const state = peerConnections[peerUuid].pc.iceConnectionState;
  if (["failed", "closed", "disconnected"].includes(state)) {
    delete peerConnections[peerUuid];
    const vidElement = document.getElementById(`remoteVideo_${peerUuid}`);
    if (vidElement) document.getElementById("videos").removeChild(vidElement);
    updateLayout();
  }
}

window.addEventListener("beforeunload", () => {
  if (videoEncoder?.state !== 'closed') {
    videoEncoder.close();
  }
  
  Object.values(peerConnections).forEach(peer => {
    if (peer.videoDecoder?.state !== 'closed') {
      peer.videoDecoder.close();
    }
    if (peer.dataChannel) {
      peer.dataChannel.close();
    }
  });
  
  serverConnection.send(JSON.stringify({
    type: "peer-disconnect",
    uuid: localUuid
  }));
});

function gotIceCandidate(event, peerUuid) {
  if (event.candidate != null) {
    serverConnection.send(JSON.stringify({
      ice: event.candidate,
      uuid: localUuid,
      dest: peerUuid,
    }));
  }
}

function createdDescription(description, peerUuid) {
  peerConnections[peerUuid].pc
    .setLocalDescription(description)
    .then(() => {
      serverConnection.send(JSON.stringify({
        sdp: peerConnections[peerUuid].pc.localDescription,
        uuid: localUuid,
        dest: peerUuid,
      }));
    }).catch(errorHandler);
}

function updateLayout() {
  const numVideos = Object.keys(peerConnections).length + 1;
  const rowHeight = numVideos > 1 && numVideos <= 4 ? "48vh" : numVideos > 4 ? "32vh" : "98vh";
  const colWidth  = numVideos > 1 && numVideos <= 4 ? "48vw" : numVideos > 4 ? "32vw" : "98vw";
  document.documentElement.style.setProperty("--rowHeight", rowHeight);
  document.documentElement.style.setProperty("--colWidth", colWidth);
}

function makeLabel(label) {
  const vidLabel = document.createElement("div");
  vidLabel.appendChild(document.createTextNode(label));
  vidLabel.setAttribute("class", "videoLabel");
  return vidLabel;
}

function createUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

function errorHandler(error) {
  console.error(error);
}
