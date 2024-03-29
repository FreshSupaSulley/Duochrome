let logo = document.getElementById("logo");
let splash = document.getElementById("splash");
let tutorial = document.getElementById("tutorial");
let tutorialDiv = document.getElementById("tutorialDiv");
let postDiv = document.getElementById("postTutorial");

// Fade in
window.onload = async function() {
  // Fade in entire document
  document.body.style.opacity = "1";
  await new Promise(res => setTimeout(res, 2000));
  // Show splash text
  logo.style.width = "150px";
  logo.style.paddingTop = "10px";
  // Show splash text
  splash.style.opacity = "1";
  // splash.style.fontSize = "17px";
  splash.innerText = "Get an activation code."
  // Show GIF tutorial
  tutorial.style.width = "500px";
  tutorialDiv.style.opacity = "1";
  postDiv.style.opacity = "1";
};