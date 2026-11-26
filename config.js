// ============================================================
//  現場情報共有システム 設定ファイル
//  Firebaseの「ウェブアプリの設定」に表示される値を下に貼り付けてください。
//  （手順は「設定手順書.html」を参照）
//  ※ここに書く値は公開されても問題ない値です。
//    データの保護はFirebase側のルールで行っています。
// ============================================================
window.APP_CONFIG = {
  appName: "現場情報共有システム",

  firebase: {
    apiKey: "AIzaSyD5rTdKMjO_NjQetwwXqzFLsLOi7kmW00s",
    authDomain: "genba-share-9ecdd.firebaseapp.com",
    projectId: "genba-share-9ecdd",
    storageBucket: "genba-share-9ecdd.firebasestorage.app",
    messagingSenderId: "96683285541",
    appId: "1:96683285541:web:d1af1e21e6855a30e9b3cc"
  },

  // 1ファイルあたりの上限サイズ（MB）
  maxFileMB: 100
};
