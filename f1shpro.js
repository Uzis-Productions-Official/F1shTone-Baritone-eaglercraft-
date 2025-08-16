<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>F1shPr0 Bot Client</title>
  <style>
    body, html { margin:0; padding:0; height:100%; overflow:hidden; background:#000; }
    #gameFrame { width:100%; height:100%; border:none; }
    #openBotBtn {
      position: fixed;
      bottom: 10px;
      left: 10px;
      padding: 8px 12px;
      background: #222;
      color: #0f0;
      border-radius: 8px;
      cursor: pointer;
      font-family: monospace;
      z-index: 9999;
    }
    #botMenu {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 300px;
      background: rgba(0,0,0,0.85);
      color: white;
      border: 2px solid #0f0;
      border-radius: 8px;
      padding: 10px;
      display: none;
      z-index: 9999;
    }
    #botMenu h2 { margin-top: 0; font-size: 18px; }
    #botMenu button { margin: 4px 0; width: 100%; padding: 6px; }
  </style>
</head>
<body>
  <!-- Eaglercraft game -->
  <iframe id="gameFrame" src="Release 1.8.8.html"></iframe>

  <!-- Open Bot Button -->
  <button id="openBotBtn">⚙️ Bot Menu</button>

  <!-- Bot Menu -->
  <div id="botMenu">
    <h2>🤖 F1shPr0 Bot</h2>
    <button onclick="botAction('get')">Get Item</button>
    <button onclick="botAction('goto')">Goto (Coords)</button>
    <button onclick="botAction('track')">Track Player</button>
    <button onclick="openBuilder()">Build (Pixel Designer)</button>
    <button onclick="closeBot()">Close</button>
  </div>

  <script src="f1shpr0.js"></script>
  <script>
    const menu = document.getElementById("botMenu");
    const btn = document.getElementById("openBotBtn");

    btn.onclick = () => { menu.style.display = "block"; };
    function closeBot() { menu.style.display = "none"; }

    function botAction(type) {
      window.postMessage({ type }, "*"); // send to f1shpr0.js
    }

    function openBuilder() {
      window.open("build.html", "builder", "width=600,height=700");
    }
  </script>
</body>
</html>
