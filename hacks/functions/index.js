"use strict";

const { randomInt } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

initializeApp();

const db = getFirestore();
const REGION = "southamerica-east1";
const ROOM_CODE_ALPHABET = "0123456789ABCDEF";
const MAX_MEMBERS = 6;
const MAX_GUESSES = 8;

function requireUser(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Entre na sua conta para jogar online.");
  }
  return request.auth.uid;
}

function validateNickname(value) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "Informe um apelido de jogador.");
  }
  const nickname = value.trim();
  if (nickname.length < 2 || nickname.length > 24) {
    throw new HttpsError("invalid-argument", "O apelido deve ter entre 2 e 24 caracteres.");
  }
  return nickname;
}

function createSecretCode() {
  const digits = Array.from({ length: 10 }, (_, index) => String(index));
  for (let index = digits.length - 1; index > 0; index -= 1) {
    const otherIndex = randomInt(index + 1);
    [digits[index], digits[otherIndex]] = [digits[otherIndex], digits[index]];
  }
  return digits.slice(0, 4).join("");
}

function createJoinCode() {
  return Array.from({ length: 10 }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join("");
}

function validateRoomId(roomId) {
  if (typeof roomId !== "string" || !/^[A-Za-z0-9]{20}$/.test(roomId)) {
    throw new HttpsError("invalid-argument", "O identificador da sala é inválido.");
  }
  return roomId;
}

exports.createOnlineRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const nickname = validateNickname(request.data?.nickname);
  const secretCode = createSecretCode();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomId = db.collection("rooms").doc().id;
    const joinCode = createJoinCode();
    const roomRef = db.collection("rooms").doc(roomId);
    const codeRef = db.collection("roomCodes").doc(joinCode);
    const secretRef = db.collection("roomSecrets").doc(roomId);
    const memberRef = roomRef.collection("members").doc(uid);
    const created = await db.runTransaction(async (transaction) => {
      const codeSnapshot = await transaction.get(codeRef);
      if (codeSnapshot.exists) return false;

      transaction.create(codeRef, { roomId });
      transaction.create(roomRef, {
        join_code: joinCode,
        createdBy: uid,
        status: "waiting",
        memberCount: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.create(memberRef, {
        userId: uid,
        nickname,
        joinedAt: FieldValue.serverTimestamp()
      });
      transaction.create(secretRef, { secretCode });
      return true;
    });
    if (created) return { roomId, joinCode };
  }

  throw new HttpsError("resource-exhausted", "Não foi possível gerar um código de sala. Tente novamente.");
});

exports.joinOnlineRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const nickname = validateNickname(request.data?.nickname);
  const joinCode = typeof request.data?.joinCode === "string"
    ? request.data.joinCode.trim().toUpperCase()
    : "";
  if (!/^[A-F0-9]{10}$/.test(joinCode)) {
    throw new HttpsError("invalid-argument", "O código da sala deve ter 10 caracteres.");
  }

  const codeSnapshot = await db.collection("roomCodes").doc(joinCode).get();
  if (!codeSnapshot.exists || typeof codeSnapshot.data().roomId !== "string") {
    throw new HttpsError("not-found", "Sala não encontrada.");
  }
  const roomId = codeSnapshot.data().roomId;
  const roomRef = db.collection("rooms").doc(roomId);
  const memberRef = roomRef.collection("members").doc(uid);

  await db.runTransaction(async (transaction) => {
    const [roomSnapshot, memberSnapshot] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(memberRef)
    ]);
    if (!roomSnapshot.exists) throw new HttpsError("not-found", "Sala não encontrada.");
    const room = roomSnapshot.data();
    if (!["waiting", "playing"].includes(room.status)) {
      throw new HttpsError("failed-precondition", "Esta partida já foi encerrada.");
    }
    if (memberSnapshot.exists) return;
    if (room.memberCount >= MAX_MEMBERS) {
      throw new HttpsError("resource-exhausted", "Esta sala já atingiu o limite de 6 jogadores.");
    }
    transaction.create(memberRef, {
      userId: uid,
      nickname,
      joinedAt: FieldValue.serverTimestamp()
    });
    transaction.update(roomRef, {
      memberCount: room.memberCount + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  return { roomId };
});

exports.startOnlineRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const roomId = validateRoomId(request.data?.roomId);
  const roomRef = db.collection("rooms").doc(roomId);

  await db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);
    if (!roomSnapshot.exists) throw new HttpsError("not-found", "Sala não encontrada.");
    const room = roomSnapshot.data();
    if (room.createdBy !== uid) {
      throw new HttpsError("permission-denied", "Somente quem criou a sala pode iniciar a partida.");
    }
    if (room.status !== "waiting") {
      throw new HttpsError("failed-precondition", "Esta sala não está aguardando o início.");
    }
    if (room.memberCount < 2) {
      throw new HttpsError("failed-precondition", "Aguarde pelo menos mais um jogador para iniciar.");
    }
    transaction.update(roomRef, {
      status: "playing",
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  return { started: true };
});

exports.submitOnlineGuess = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const roomId = validateRoomId(request.data?.roomId);
  const guess = typeof request.data?.guess === "string" ? request.data.guess : "";
  if (!/^[0-9]{4}$/.test(guess) || new Set(guess).size !== 4) {
    throw new HttpsError("invalid-argument", "Digite 4 dígitos diferentes.");
  }

  const roomRef = db.collection("rooms").doc(roomId);
  const memberRef = roomRef.collection("members").doc(uid);
  const secretRef = db.collection("roomSecrets").doc(roomId);
  const guessesRef = roomRef.collection("guesses");

  await db.runTransaction(async (transaction) => {
    const [roomSnapshot, memberSnapshot, secretSnapshot, guessesSnapshot] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(memberRef),
      transaction.get(secretRef),
      transaction.get(guessesRef.orderBy("guess_number"))
    ]);
    if (!roomSnapshot.exists) throw new HttpsError("not-found", "Sala não encontrada.");
    if (!memberSnapshot.exists) throw new HttpsError("permission-denied", "Você não participa desta sala.");
    const room = roomSnapshot.data();
    if (room.status !== "playing") {
      throw new HttpsError("failed-precondition", "A partida não está em andamento.");
    }
    if (!secretSnapshot.exists) {
      throw new HttpsError("internal", "A sequência da sala não está disponível.");
    }
    if (guessesSnapshot.size >= MAX_GUESSES) {
      throw new HttpsError("failed-precondition", "As tentativas desta partida acabaram.");
    }

    const secretCode = secretSnapshot.data().secretCode;
    const exactCount = [...guess].reduce((count, digit, index) => (
      count + (digit === secretCode[index] ? 1 : 0)
    ), 0);
    const commonCount = [...guess].reduce((count, digit) => (
      count + (secretCode.includes(digit) ? 1 : 0)
    ), 0);
    const guessNumber = guessesSnapshot.size + 1;
    const guessRef = guessesRef.doc(String(guessNumber).padStart(2, "0"));
    const status = exactCount === 4
      ? "won"
      : guessNumber >= MAX_GUESSES ? "lost" : "playing";
    const guessData = {
      guess_number: guessNumber,
      guess_code: guess,
      exact_count: exactCount,
      misplaced_count: commonCount - exactCount,
      nickname: memberSnapshot.data().nickname,
      userId: uid,
      createdAt: FieldValue.serverTimestamp()
    };

    transaction.create(guessRef, guessData);
    transaction.update(roomRef, {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      ...(status === "won" || status === "lost" ? { revealedCode: secretCode } : {})
    });
  });

  return { submitted: true };
});
