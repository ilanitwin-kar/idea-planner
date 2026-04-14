import { enableFirebaseSync, firebaseConfig } from "./firebase-config.js";

export async function initCloudSync({ onRemoteState, onStatus }) {
  if (!enableFirebaseSync) {
    onStatus?.({ mode: "local", userEmail: null, enabled: false });
    return createNoopSync(onStatus);
  }
  if (!firebaseConfig?.apiKey || !firebaseConfig?.authDomain || !firebaseConfig?.projectId) {
    onStatus?.({ mode: "local", userEmail: null, enabled: false, error: "חסר firebaseConfig" });
    return createNoopSync(onStatus);
  }

  const [{ initializeApp }, { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut }, { getFirestore, doc, onSnapshot, setDoc, serverTimestamp }] =
    await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
    ]);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  let unsub = null;
  let currentUid = null;

  const stop = () => {
    if (unsub) unsub();
    unsub = null;
  };

  const startUserListener = (uid) => {
    stop();
    const ref = doc(db, "users", uid, "app", "state");
    unsub = onSnapshot(
      ref,
      (snap) => {
        const data = snap.data();
        if (!data?.state) return;
        onRemoteState?.(data.state);
      },
      (err) => {
        onStatus?.({ mode: "local", userEmail: auth.currentUser?.email ?? null, enabled: true, error: String(err?.message ?? err) });
      },
    );
  };

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      currentUid = null;
      stop();
      onStatus?.({ mode: "local", userEmail: null, userUid: null, enabled: true });
      return;
    }
    currentUid = user.uid;
    onStatus?.({ mode: "cloud", userEmail: user.email ?? null, userUid: user.uid, enabled: true });
    startUserListener(user.uid);
  });

  async function pushState(state) {
    if (!currentUid) return;
    const ref = doc(db, "users", currentUid, "app", "state");
    await setDoc(
      ref,
      {
        state,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  return {
    enabled: true,
    login: async (email, password) => signInWithEmailAndPassword(auth, email, password),
    signup: async (email, password) => createUserWithEmailAndPassword(auth, email, password),
    logout: async () => signOut(auth),
    pushState,
  };
}

function createNoopSync(onStatus) {
  onStatus?.({ mode: "local", userEmail: null, enabled: false });
  return {
    enabled: false,
    login: async () => {
      throw new Error("סנכרון לא מופעל עדיין (enableFirebaseSync=false)");
    },
    signup: async () => {
      throw new Error("סנכרון לא מופעל עדיין (enableFirebaseSync=false)");
    },
    logout: async () => {},
    pushState: async () => {},
  };
}

