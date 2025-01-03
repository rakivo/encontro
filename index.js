let peerConnections = {};
let localUuid, localDisplayName, localStream, serverConnection;

const WS_PORT = 8443;
const PEER_CONNECTION_CFG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function start() {
  localUuid = createUUID();

  const urlParams = new URLSearchParams(window.location.search);
  localDisplayName = urlParams.get("displayName") || localUuid;

  document.getElementById("localVideoContainer").appendChild(makeLabel(localDisplayName));

  const CONSTRAINTS = {
    video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } },
    audio: false
  };

  if (navigator.mediaDevices.getDisplayMedia) {
    navigator.mediaDevices.getDisplayMedia(CONSTRAINTS)
      .then((stream) => {
        localStream = stream;
        document.getElementById("localVideo").srcObject = stream;
      }).catch(errorHandler).then(() => {
        serverConnection = new WebSocket(`wss://${location.hostname}:8443/ws/`);
        serverConnection.onmessage = gotMessageFromServer;
        serverConnection.onopen = () => {
          serverConnection.send(JSON.stringify({
            displayName: localDisplayName,
            uuid: localUuid,
            dest: "all",
          }));
        };
      }).catch(errorHandler);
  } else {
    alert("Your browser does not support getUserMedia API");
  }
}

window.addEventListener("beforeunload", () => {
  serverConnection.send(JSON.stringify({
    type: "peer-disconnect",
    uuid: localUuid
  }));
});

function gotMessageFromServer(message) {
  const signal = JSON.parse(message.data);
  const peerUuid = signal.uuid;

  if (peerUuid === localUuid || (signal.dest !== localUuid && signal.dest !== "all")) return;

  if (signal.type === "peer-disconnect") {
    const peerUuid = signal.uuid;
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

function setUpPeer(peerUuid, displayName, initCall = false) {
  peerConnections[peerUuid] = {
    displayName,
    pc: new RTCPeerConnection(PEER_CONNECTION_CFG),
  };
  peerConnections[peerUuid].pc.onicecandidate = (event) => gotIceCandidate(event, peerUuid);
  peerConnections[peerUuid].pc.ontrack = (event) => gotRemoteStream(event, peerUuid);
  peerConnections[peerUuid].pc.oniceconnectionstatechange = (event) => checkPeerDisconnect(event, peerUuid);
  peerConnections[peerUuid].pc.addStream(localStream);
  if (initCall) {
    peerConnections[peerUuid].pc
      .createOffer()
      .then((description) => createdDescription(description, peerUuid))
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
