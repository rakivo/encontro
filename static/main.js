"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
let peerConnections = {};
let videoEncoder = null;
let localUuid, localDisplayName, localStream;
let serverConnection = null;
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
        frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
};
const ENCODER_CFG = {
    codec: 'vp8',
    width: 1280,
    height: 720,
    framerate: 30,
    bitrate: 1000000,
    latencyMode: 'realtime',
};
const DECODER_CFG = {
    codec: ENCODER_CFG.codec,
    codedWidth: ENCODER_CFG.width,
    codedHeight: ENCODER_CFG.height,
    hardwareAcceleration: "no-preference",
};
function initializeCodecs(stream) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!('VideoEncoder' in window))
            return;
        const videoTrack = stream.getVideoTracks()[0];
        const trackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
        const frameReader = trackProcessor.readable.getReader();
        videoEncoder = new VideoEncoder({
            output: (encodedChunk) => {
                const data = new ArrayBuffer(encodedChunk.byteLength);
                const view = new Uint8Array(data);
                encodedChunk.copyTo(view);
                Object.values(peerConnections).forEach((peer) => {
                    var _a;
                    if (((_a = peer.dataChannel) === null || _a === void 0 ? void 0 : _a.readyState) === 'open') {
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
        yield videoEncoder.configure(ENCODER_CFG);
        const processFrames = () => __awaiter(this, void 0, void 0, function* () {
            try {
                while (true) {
                    const { value: frame, done } = yield frameReader.read();
                    if (done)
                        break;
                    if ((videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.state) === 'configured') {
                        videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.encode(frame);
                    }
                    frame.close();
                }
            }
            catch (e) {
                console.error('Error processing frames:', e);
            }
        });
        processFrames();
    });
}
function start() {
    return __awaiter(this, void 0, void 0, function* () {
        localUuid = createUUID();
        const urlParams = new URLSearchParams(window.location.search);
        localDisplayName = urlParams.get("displayName") || localUuid;
        const labelContainer = document.getElementById("localVideoContainer");
        if (labelContainer)
            labelContainer.appendChild(makeLabel(localDisplayName));
        try {
            localStream = yield getMediaStream();
            const localVideo = document.getElementById("localVideo");
            localVideo.srcObject = localStream;
            yield initializeCodecs(localStream);
            serverConnection = new WebSocket(`wss://${location.hostname}:${WS_PORT}/ws/`);
            serverConnection.onmessage = (msg) => gotMessageFromServer(msg);
            serverConnection.onopen = () => {
                serverConnection.send(JSON.stringify({ displayName: localDisplayName, uuid: localUuid, dest: "all" }));
            };
        }
        catch (error) {
            errorHandler(error);
        }
    });
}
function getMediaStream() {
    return __awaiter(this, void 0, void 0, function* () {
        if (navigator.mediaDevices.getDisplayMedia) {
            return yield navigator.mediaDevices.getDisplayMedia(CONSTRAINTS);
        }
        else if (navigator.mediaDevices.getUserMedia) {
            return yield navigator.mediaDevices.getUserMedia(CONSTRAINTS);
        }
        else {
            alert("Your browser does not support getDisplayMedia or getUserMedia API");
            throw new Error("Unsupported media API");
        }
    });
}
function setUpPeer(peerUuid, displayName, initCall = false) {
    const peerConnection = {
        displayName,
        pc: new RTCPeerConnection(PEER_CONNECTION_CFG),
    };
    const dataChannel = peerConnection.pc.createDataChannel('video-channel');
    peerConnection.dataChannel = dataChannel;
    let writable;
    let mediaStreamGenerator;
    let metadata;
    dataChannel.onopen = () => __awaiter(this, void 0, void 0, function* () {
        if (!('VideoDecoder' in window))
            return;
        peerConnection.videoDecoder = new VideoDecoder({
            output: (frame) => {
                if (!mediaStreamGenerator) {
                    mediaStreamGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
                    writable = mediaStreamGenerator.writable.getWriter();
                    const stream = new MediaStream([mediaStreamGenerator]);
                    const vidElement = document.querySelector(`#remoteVideo_${peerUuid} video`);
                    if (vidElement)
                        vidElement.srcObject = stream;
                }
                writable.write(frame);
            },
            error: (e) => console.error(e),
        });
        yield peerConnection.videoDecoder.configure(DECODER_CFG);
    });
    dataChannel.onmessage = (event) => __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (typeof event.data === 'string') {
            metadata = JSON.parse(event.data);
        }
        else {
            const chunk = new EncodedVideoChunk({
                type: metadata.type,
                timestamp: metadata.timestamp,
                duration: metadata.duration,
                data: event.data,
            });
            if (((_a = peerConnection.videoDecoder) === null || _a === void 0 ? void 0 : _a.state) === 'configured') {
                peerConnection.videoDecoder.decode(chunk);
            }
        }
    });
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
function gotMessageFromServer(message) {
    const signal = JSON.parse(message.data);
    const peerUuid = signal.uuid;
    if (peerUuid === localUuid || (signal.dest !== localUuid && signal.dest !== "all"))
        return;
    if (signal.type === "peer-disconnect") {
        handlePeerDisconnect(peerUuid);
        return;
    }
    if (signal.displayName && signal.dest === "all") {
        setUpPeer(peerUuid, signal.displayName);
        serverConnection.send(JSON.stringify({ displayName: localDisplayName, uuid: localUuid, dest: peerUuid }));
    }
    else if (signal.displayName && signal.dest === localUuid) {
        setUpPeer(peerUuid, signal.displayName, true);
    }
    else if (signal.sdp) {
        handleSdpSignal(signal, peerUuid);
    }
    else if (signal.ice) {
        handleIceCandidate(signal, peerUuid);
    }
}
function handleSdpSignal(signal, peerUuid) {
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
function handleIceCandidate(signal, peerUuid) {
    peerConnections[peerUuid].pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
}
function handlePeerDisconnect(peerUuid) {
    var _a;
    console.log(`Peer ${peerUuid} disconnected`);
    delete peerConnections[peerUuid];
    const vidElement = document.getElementById(`remoteVideo_${peerUuid}`);
    if (vidElement)
        (_a = document.getElementById("videos")) === null || _a === void 0 ? void 0 : _a.removeChild(vidElement);
    updateLayout();
}
function gotRemoteStream(event, peerUuid) {
    var _a;
    const vidElement = document.createElement("video");
    vidElement.setAttribute("autoplay", "");
    vidElement.setAttribute("muted", "");
    vidElement.srcObject = event.streams[0];
    const vidContainer = document.createElement("div");
    vidContainer.id = `remoteVideo_${peerUuid}`;
    vidContainer.className = "videoContainer";
    vidContainer.appendChild(vidElement);
    vidContainer.appendChild(makeLabel(peerConnections[peerUuid].displayName));
    (_a = document.getElementById("videos")) === null || _a === void 0 ? void 0 : _a.appendChild(vidContainer);
    updateLayout();
}
function checkPeerDisconnect(peerUuid) {
    const state = peerConnections[peerUuid].pc.iceConnectionState;
    if (["failed", "closed", "disconnected"].includes(state)) {
        handlePeerDisconnect(peerUuid);
    }
}
function gotIceCandidate(event, peerUuid) {
    if (event.candidate) {
        serverConnection.send(JSON.stringify({ ice: event.candidate, uuid: localUuid, dest: peerUuid }));
    }
}
function createdDescription(description, peerUuid) {
    peerConnections[peerUuid].pc.setLocalDescription(description)
        .then(() => {
        serverConnection.send(JSON.stringify({
            sdp: peerConnections[peerUuid].pc.localDescription,
            uuid: localUuid,
            dest: peerUuid,
        }));
    })
        .catch(errorHandler);
}
function updateLayout() {
    const numVideos = Object.keys(peerConnections).length + 1;
    const rowHeight = numVideos > 1 && numVideos <= 4 ? "48vh" : numVideos > 4 ? "32vh" : "98vh";
    const colWidth = numVideos > 1 && numVideos <= 4 ? "48vw" : numVideos > 4 ? "32vw" : "98vw";
    document.documentElement.style.setProperty("--rowHeight", rowHeight);
    document.documentElement.style.setProperty("--colWidth", colWidth);
}
function makeLabel(label) {
    const vidLabel = document.createElement("div");
    vidLabel.textContent = label;
    vidLabel.className = "videoLabel";
    return vidLabel;
}
function createUUID() {
    return ([1e7, -1e3, -4e3, -8e3, -1e11].join('')).replace(/[018]/g, (c) => (parseInt(c, 16) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (parseInt(c, 16) / 4)))).toString(16));
}
function errorHandler(error) {
    console.error(error);
}
window.addEventListener("beforeunload", () => {
    if ((videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.state) !== 'closed') {
        videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.close();
    }
    Object.values(peerConnections).forEach(peer => {
        var _a, _b;
        if (((_a = peer.videoDecoder) === null || _a === void 0 ? void 0 : _a.state) !== 'closed') {
            (_b = peer.videoDecoder) === null || _b === void 0 ? void 0 : _b.close();
        }
        if (peer.dataChannel) {
            peer.dataChannel.close();
        }
    });
    serverConnection === null || serverConnection === void 0 ? void 0 : serverConnection.send(JSON.stringify({
        type: "peer-disconnect",
        uuid: localUuid
    }));
});
