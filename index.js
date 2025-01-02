// The MIT License (MIT)

// Copyright (c) 2014 Shane Tully

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

let peerConnections = {};
let localStream;
let localVideo;
let peerConnection;
let remoteVideo;
let serverConnection;
let uuid;

const peerConnectionConfig = {
  'iceServers': [
    {'urls': 'stun:stun.stunprotocol.org:3478'},
    {'urls': 'stun:stun.l.google.com:19302'},
  ]
};

async function pageReady() {
  uuid = createUUID();

  localVideo = document.getElementById('localVideo');
  remoteVideo = document.getElementById('remoteVideo');

  serverConnection = new WebSocket('wss://localhost:8443/ws/room1');
  serverConnection.onmessage = gotMessageFromServer;

  const constraints = {
    video: true,
    audio: false
  };

  if (!navigator.mediaDevices.getUserMedia) {
    alert('Your browser does not support getUserMedia API');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStream = stream;
    localVideo.srcObject = stream;
  } catch(error) {
    errorHandler(error);
  }
}

function startConnection(isCaller, remoteId) {
    const peerConnection = new RTCPeerConnection(peerConnectionConfig);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            serverConnection.send(JSON.stringify({
                ice: event.candidate,
                uuid: uuid,
                target: remoteId,
            }));
        }
    };

    peerConnection.ontrack = (event) => {
        const remoteVideo = document.createElement('video');
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.autoplay = true;
        document.body.appendChild(remoteVideo);
    };

    for (const track of localStream.getTracks()) {
        peerConnection.addTrack(track, localStream);
    }

    peerConnections[remoteId] = peerConnection;

    if (isCaller) {
        peerConnection.createOffer()
            .then((description) => {
                peerConnection.setLocalDescription(description);
                serverConnection.send(JSON.stringify({
                    sdp: description,
                    uuid: uuid,
                    target: remoteId,
                }));
            })
            .catch(errorHandler);
    }
}

function gotMessageFromServer(message) {
  if (!peerConnection) startConnection(false);

  const signal = JSON.parse(message.data);

  // Ignore messages from ourself
  if (signal.uuid == uuid) return;

  const targetId = signal.target;

  if (signal.sdp) {
      if (!peerConnections[targetId]) {
          startConnection(false, targetId);
      }

      peerConnections[targetId].setRemoteDescription(new RTCSessionDescription(signal.sdp))
          .then(() => {
              if (signal.sdp.type === 'offer') {
                  peerConnections[targetId].createAnswer()
                      .then((description) => {
                          peerConnections[targetId].setLocalDescription(description);
                          serverConnection.send(JSON.stringify({
                              sdp: description,
                              uuid: uuid,
                              target: targetId,
                          }));
                      })
                      .catch(errorHandler);
              }
          })
          .catch(errorHandler);
  } else if (signal.ice) {
      peerConnections[targetId].addIceCandidate(new RTCIceCandidate(signal.ice))
          .catch(errorHandler);
  } else if (signal.type === 'new_user') {
    startConnection(true, targetId);
  }
}

function gotIceCandidate(event) {
  if (event.candidate != null) {
    serverConnection.send(JSON.stringify({'ice': event.candidate, 'uuid': uuid}));
  }
}

function createdDescription(description) {
  console.log('got description');

  peerConnection.setLocalDescription(description).then(() => {
    serverConnection.send(JSON.stringify({'sdp': peerConnection.localDescription, 'uuid': uuid}));
  }).catch(errorHandler);
}

function gotRemoteStream(event) {
  console.log('got remote stream');
  remoteVideo.srcObject = event.streams[0];
}

function errorHandler(error) {
  console.log(error);
}

// Taken from http://stackoverflow.com/a/105074/515584
// Strictly speaking, it's not a real UUID, but it gets the job done here
function createUUID() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  }

  return `${s4() + s4()}-${s4()}-${s4()}-${s4()}-${s4() + s4() + s4()}`;
}
