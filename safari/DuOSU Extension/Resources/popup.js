// Determines which slide should be visible on startup page
let slideIndex = 0;

// Dark / Light theme
document.getElementById("daynight").addEventListener("click", async function() {
  let data = await new Promise(function(resolve) {
    browser.storage.local.get('theme', function(value) {
      resolve(value);
    });
  });
  // If button has been pressed before
  if(data != null) {
    let theme = !data.theme;
    // Set it to the opposite of what we have
    await browser.storage.local.set({"theme": theme});
    document.documentElement.setAttribute("dark-theme", theme);
  } else {
    // First time pressing the button, meaning we go to dark theme
    await browser.storage.local.set({"theme": false});
  }
});

// Previous slide
document.getElementById("prev").addEventListener("click", function() {
  slideIndex -= 1;
  updateSlide(slideIndex);
});

// Next slide
document.getElementById("next").addEventListener("click", function() {
  slideIndex += 1;
  updateSlide(slideIndex);
});

// Help button
document.getElementById("helpButton").addEventListener("click", function() {
  changeScreen("failedAttempts");
  failedAttempts = 0;
});

// Submit activation
let errorSplash = document.getElementById("errorSplash");
let activateButton = document.getElementById("activateButton");

activateButton.addEventListener("click", async function() {
  // Disable button so user can't spam it
  activateButton.disabled = true;
  errorSplash.innerText = "Activating...";
  activateButton.innerText = "Working...";

  try {
    // Split activation code into its two components: identifier and host.
    let code = document.getElementById('code').value.split('-');
    // Decode Base64 to get host
    let host = atob(code[1]);
    let identifier = code[0];
    // Ensure this code is correct by counting the characters
    if(code[0].length != 20 || code[1].length != 38) {
      throw "Illegal number of characters in activation code";
    }
    // Make request. Throws an error if an error occurs
    await activateDevice(host, identifier);
    // Hide setup page and show success page
    changeScreen("activationSuccess");
  } catch(error) {
    if(error == "Expired") {
      errorSplash.innerText = "Activation code expired. Create a new activation link and try again.";
    }
    else {
      // Timeouts will be caught here
      console.error(JSON.stringify(error));
      errorSplash.innerText = "Invalid code. Look at the picture! Open the link sent to your email and copy the code from the box.";
    }
  }

  // Re-enable button
  activateButton.disabled = false;
  activateButton.innerText = "Retry";
});

// Switch to main page after success button is pressed
let mainButtons = document.getElementsByClassName("toMainScreen");
for(let i = 0; i < mainButtons.length; i++) {
  mainButtons[i].addEventListener("click", function() {
    changeScreen("main");
  });
}

async function activateDevice(host, identifier) {
  let url = 'https://' + host + '/push/v2/activation/' + identifier;

  // Create new pair of RSA keys
  let keyPair = await window.crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    hash: "SHA-512"
  }, true, ["sign", "verify"]);

  // Convert public key to PEM format to send to Duo
  let pemFormat = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
  pemFormat = window.btoa(String.fromCharCode(...new Uint8Array(pemFormat))).match(/.{1,64}/g).join('\n');
  pemFormat = `-----BEGIN PUBLIC KEY-----\n${pemFormat}\n-----END PUBLIC KEY-----`;

  // Exporting keys returns an array buffer. Convert it to Base64 string for storing
  let publicRaw = arrayBufferToBase64(await window.crypto.subtle.exportKey("spki", keyPair.publicKey));
  let privateRaw = arrayBufferToBase64(await window.crypto.subtle.exportKey("pkcs8", keyPair.privateKey));

  // Initialize new HTTP request
  let request = new XMLHttpRequest();
  let error = false;
  request.open('POST', url, true);
  request.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
  // Put onload() in a Promise. It will be raced with a timeout promise
  let newData = new Promise((resolve, reject) => {
    request.onload = async function () {
      let result = JSON.parse(request.responseText);
      // If successful
      if (result.stat == "OK") {
        // Get device info as JSON
        let deviceInfo = {
          "akey": result.response.akey,
          "pkey": result.response.pkey,
          "host": host,
          // Encode keys to Base64 for JSON serializing
          "publicRaw": publicRaw,
          "privateRaw": privateRaw
        };
        // Store device info in browser sync
        await browser.storage.sync.set({"deviceInfo": deviceInfo});
        resolve("Success");
      }
      else {
        // If we receive a result from Duo and the status is FAIL, the activation code is likely expired
        console.error(result);
        reject("Expired");
      }
    };
  });
  // Append URL parameters and begin request
  request.send("?customer_protocol=1&pubkey=" + encodeURIComponent(pemFormat) + "&pkpush=rsa-sha512&jailbroken=false&architecture=arm64&region=US&app_id=com.duosecurity.duomobile&full_disk_encryption=true&passcode_status=true&platform=Android&app_version=3.49.0&app_build_number=323001&version=11&manufacturer=unknown&language=en&model=Safari%20Extension&security_patch_level=2021-02-01");
  // Create timeout promise
  let timeout = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject("Timed out");
    }, 1500);
  });
  // Wait for response, or timeout at 1.5s
  // We need a timeout because request.send() doesn't return an error when an exception occurs, and onload() is obviously never called
  await Promise.race([newData, timeout]);
}

// On settings gear clicked
let inSettings = false;
let gear = document.getElementById("gear");
gear.addEventListener("click", async function() {
  // If this is the first time we're clicking the gear
  if(!inSettings) {
    // Set gear color to red
    gear.style.fill = "red";
    changeScreen("settings");
  }
  // If we already clicked this
  else {
    // In case the data was tampered with in the settings
    await initialize();
    // Set gear color back to gray
    gear.style.fill = "gray";
    // Don't count flipping back to main page as an attempt
    failedAttempts = 0;
  }
  inSettings = !inSettings;
});

let splash = document.getElementById("splash");
let successDetails = document.getElementById("successDetails");
let transactionsSplash = document.getElementById("transactionsSplash");
let pushButton = document.getElementById("pushButton");
let approveTable = document.getElementById("approveTable");
let failedReason = document.getElementById("failedReason");
let failedAttempts = 0;

// When the push button is pressed on the main screen (or on open)
pushButton.addEventListener("click", async function() {
  // Disable button while making Duo request
  pushButton.disabled = true;
  pushButton.innerText = "Working...";
  splash.innerHTML = "Checking for Duo logins...";
  try {
    // Get device info from storage
    let info = await getDeviceInfo();
    let transactions = (await buildRequest(info, "GET", "/push/v2/device/transactions")).response.transactions;
    // If no transactions exist at the moment
    if(transactions.length == 0) {
      failedAttempts++;
      splash.innerHTML = "No logins found!";
    }
    // Expected response: Only 1 transaction should exist
    // Only auto-approve this transaction if one-click logins are enabled
    else if(transactions.length == 1 && !info.reviewPush) {
      // Push the single transaction
      // Throws an error if something goes wrong
      await approveTransaction(info, transactions[0].urgid);
      // Switch to success screen
      successDetails.innerHTML = traverse(transactions[0].attributes);
      failedAttempts = 0;
      changeScreen("success");
    }
    // There shouldn't be more than one transaction
    // Present all to the user
    else {
      // If one-click logins are disabled
      if(transactions.length == 1) {
        transactionsSplash.innerHTML = "Is this your login?";
      } else {
        // If multiple login attempts exist
        transactionsSplash.innerHTML = "There's " + transactions.length + " login attempts.<br>Which one are you?";
      }
      // Switch to transactions screen
      changeScreen("transactions");
      // Also reset the transactions page
      while(approveTable.firstChild) {
        approveTable.removeChild(approveTable.lastChild);
      }
      // For each transaction
      for(let i = 0; i < transactions.length; i++) {
        let row = document.createElement("tr");
        // First column
        let c1 = document.createElement("td");
        let approve = document.createElement("button");
        approve.innerHTML = "&#x2713;";
        approve.className = "approve";
        approve.onclick = async () => {
          // Catch any possible errors
          try {
            // Display loading
            approveTable.style.display = "none";
            transactionsSplash.innerText = "Working...";
            // Approve the transaction
            await approveTransaction(info, transactions[i].urgid);
            successDetails.innerHTML = traverse(transactions[i].attributes);
            changeScreen("success");
          } catch(e) {
            console.error(e);
            failedReason.innerText = `"${e}"`;
            changeScreen("failure");
          } finally {
            // Reset elements
            approveTable.style.display = "block";
          }
        }
        c1.appendChild(approve);

        // 2nd column
        let c2 = document.createElement("td");
        let p = document.createElement("p");
        // I have no way of knowing if array sizes vary per organization, so pick and choose isn't an option
        // The solution is to traverse through the JSON and find all key/value pairs
        p.innerHTML = traverse(transactions[i].attributes);
        p.style = "text-align: left; font-size: 12px; margin: 10px 0px";
        c2.appendChild(p);

        row.appendChild(c1);
        row.appendChild(c2);
        approveTable.appendChild(row);
      }
    }
  } catch(error) {
    failedReason.innerText = `"${error}"`;
    failedAttempts = 0;
    console.error(error);
    changeScreen("failure");
  }

  // Re-enable button
  pushButton.disabled = false;
  pushButton.innerHTML = "Try Again";
  // If we couldn't login after many attemps
  if(failedAttempts >= 4) {
    failedAttempts = 0;
    // Remind the user how DuOSU works
    changeScreen("failedAttempts");
  }
});

function traverse(json) {
  // If JSON is an array
  if(json !== null && Array.isArray(json)) {
    // If first object is a string (it's a key)
    if(json.length == 2 && typeof json[0] === 'string') {
      let key = json[0];
      let value = json[1];
      // Toss out the unnecessary key/value pairs
      switch (json[0]) {
        // These values should stay the same regardless of the login, because it's the same account
        case "Username": case "Organization":
          return null;
        // Convert time to better form
        case "Time":
          // Epoch millis are returned as seconds
          // Convert to millis
          let d = new Date(Math.round(value) * 1000);
          // Day month year
          let display = (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
          display += " at ";
          let AMPM = (d.getHours() > 11) ? "PM" : "AM";
          let scaled = (d.getHours() < 13 ? d.getHours() : d.getHours() - 12);
          // Convert from military time
          display += (scaled % 12 == 0 ? 12 : scaled) + ":" + twoDigits(d.getMinutes()) + ":" + twoDigits(d.getSeconds()) + " " + AMPM;
          value = display;
          break;
      }
      return `<b>${key}</b>: ${value}<br>`;
    } else {
      // Traverse
      let data = "";
      for(let i = 0; i < json.length; i++) {
        let branch = traverse(json[i]);
        if(branch !== null) {
          data += branch;
        }
      }
      return data;
    }
  } else {
    // Wrong format (shouldn't happen)
    console.error("Unexpected JSON format: " + json);
    return null;
  }
}

// Approves the transaction ID provided, denies all others
// Throws an exception if no transactions are active
async function approveTransaction(info, txID) {
  let transactions = (await buildRequest(info, "GET", "/push/v2/device/transactions")).response.transactions;
  if(transactions.length == 0) {
    throw "No transactions found (request expired)";
  }
  for(let i = 0; i < transactions.length; i++) {
    let urgID = transactions[i].urgid;
    if(txID == urgID) {
      // Only approve this one
      let response = await buildRequest(info, "POST", "/push/v2/device/transactions/" + urgID, {"answer": "approve"}, {"txId": urgID});
      if(response.stat != "OK") {
        console.error(response);
        throw "Duo returned error status " + response.stat + " while approving login";
      }
    } else {
      // Deny all others
      // Don't bother handling the response
      buildRequest(info, "POST", "/push/v2/device/transactions/" + urgID, {"answer": "deny"}, {"txId": urgID});
    }
  }
}

// When the user presses the 'Got it' button on the failure screen
document.getElementById("failureButton").addEventListener("click", function() {
  changeScreen("main");
});

// When the user presses the button on the intro screen, switch to activation
document.getElementById("introButton").addEventListener("click", function() {
  changeScreen("activation");
});

// Makes a request to the Duo API
async function buildRequest(info, method, path, extraParam = {}, extraHeader = {}) {
  // Manually convert date to UTC
  let now = new Date();
  var utc = new Date(now.getTime() + now.getTimezoneOffset() * 60000);

  // Manually format time because JS doesn't provide regex functions for this
  let date = utc.toLocaleString('en-us', {weekday: 'long'}).substring(0, 3) + ", ";
  date += utc.getDate() + " ";
  date += utc.toLocaleString('en-us', {month: 'long'}).substring(0, 3) + " ";
  date += 1900 + utc.getYear() + " ";
  date += twoDigits(utc.getHours()) + ":";
  date += twoDigits(utc.getMinutes()) + ":";
  date += twoDigits(utc.getSeconds()) + " -0000";

  // Create canolicalized request (signature of auth header)
  // Technically, these parameters should be sorted alphabetically
  // But for our purposes we don't need to for our only extra parameter (answer=approve)
  let canonRequest = date + "\n" + method + "\n" + info.host + "\n" + path + "\n";
  let params = "";

  // We only use 1 extra parameter, but this shouldn't break for extra
  for (const [key, value] of Object.entries(extraParam)) {
    params += "&" + key + "=" + value;
  }

  // Add extra params to canonical request for auth
  if(params.length != 0) {
    // Cutoff first '&'
    params = params.substring(1);
    canonRequest += params;
    // Add '?' for URL when we make fetch request
    params = "?" + params
  }

  // Import keys (convert form Base64 back into ArrayBuffer)
  let publicKey = await window.crypto.subtle.importKey("spki", base64ToArrayBuffer(info.publicRaw), {name: "RSASSA-PKCS1-v1_5", hash: {name: 'SHA-512'},}, true, ["verify"]);
  let privateKey = await window.crypto.subtle.importKey("pkcs8", base64ToArrayBuffer(info.privateRaw), {name: "RSASSA-PKCS1-v1_5", hash: {name: "SHA-512"},}, true, ["sign"]);

  // Sign canonicalized request using RSA private key
  let toEncrypt = new TextEncoder().encode(canonRequest);
  let signed = await window.crypto.subtle.sign({name: "RSASSA-PKCS1-v1_5"}, privateKey, toEncrypt);
  let verified = await window.crypto.subtle.verify({name: "RSASSA-PKCS1-v1_5"}, publicKey, signed, toEncrypt);

  // Ensure keys match
  if(!verified) {
    throw("Failed to verify signature with RSA keys");
  }

  // Required headers for all requests
  let headers = {
    "Authorization": "Basic " + window.btoa(info.pkey + ":" + arrayBufferToBase64(signed)),
    "x-duo-date": date
  }

  // Append additional headers (we only use txId during transaction reply)
  // Unlike extraParams, this won't break if more are supplied (which we don't need)
  for (const [key, value] of Object.entries(extraHeader)) {
    headers[key] = value;
  }

  let result = await fetch("https://" + info.host + path + params, {
    method: method,
    headers: headers
  }).then(response => {
    if(!response.ok) {
      console.error(response);
      throw "Duo denied handling request at " + path + " (was the device deleted?)";
    } else {
      return response.json();
    }
  });

  return result;
}

// For formatting date header
function twoDigits(input) {
  return input.toString().padStart(2, '0');
}

// Changes the active screen of the page (activation or main)
async function changeScreen(id) {
  if(id == "activation") {
    // Initialize the active slide (this is necessary on startup)
    updateSlide(slideIndex);
  }
  // Settings
  else if(id == "settings") {
    // Set the one-click login box if enabled or not
    let info = await getDeviceInfo();
    if(info == null) {
      clickLogin.disabled = true;
    } else {
      clickLogin.disabled = false;
      // If one-click logins are enabled
      if(!info.reviewPush) {
        clickLogin.checked = true;
      } else {
        clickLogin.checked = false;
      }
    }
    // Make sure when we go to settings, we reset the main page
    splash.innerHTML = "Click to approve Duo Mobile logins.";
    pushButton.innerText = "Login";
  }
  // Auto press the button on open
  else if(id == "main") {
    pushButton.click();
  }

  let screens = document.getElementsByClassName("screen");
  // For each screen div
  for(let i = 0; i < screens.length; i++) {
    let div = screens[i];
    // If this is the screen we want to switch to
    if(div.id == id) {
      // Make it visible
      div.style.display = "block";
    }
    // Make all others invisible
    else {
      div.style.display = "none";
    }
  }
}

// Change the current slide on activation screen
function updateSlide(newIndex) {
  let slides = document.getElementsByClassName("slide");

  for(let i = 0; i < slides.length; i++) {
    slides[i].style.display = "none";
  }

  // Clamp newIndex within bounds
  if(newIndex > slides.length - 1) slideIndex = 0;
  else if(newIndex < 0) slideIndex = slides.length - 1;

  // Store in case user clicks off to browse to Duo tab so they don't have to flip back
  browser.storage.local.set({"activeSlide": slideIndex});
  slides[slideIndex].style.display = "block";

  // Update slide count
  let count = document.getElementById("counter");
  count.textContent = (slideIndex + 1) + "/" + slides.length;
}

// Convert Base64 string to an ArrayBuffer
function base64ToArrayBuffer(base64) {
  var binary_string = window.atob(base64);
  var len = binary_string.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

// Convert an ArrayBuffer to Base64 encoded string
function arrayBufferToBase64(buffer) {
  let binary = "";
  let bytes = new Uint8Array(buffer);
  let len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// One-click login
let clickLogin = document.getElementById("clickLogin")
clickLogin.addEventListener('change', async (event) => {
  let data = await getDeviceInfo();
  if(data != null) {
    // Set new data
    data.reviewPush = !clickLogin.checked;
    await browser.storage.sync.set({"deviceInfo": data});
  }
});

// Import button
let importText = document.getElementById("importText");
let importSplash = document.getElementById("importSplash");
document.getElementById("importButton").addEventListener("click", async function() {
  try {
    let decoded = window.atob(importText.value);
    let json = JSON.parse(decoded);
    // Tell user we are verifying the integrity of the data
    importSplash.innerText = "Verifying..."
    // We do this by running it through a transactions call
    let transactions = (await buildRequest(json, "GET", "/push/v2/device/transactions")).response.transactions;
    // If an error wasn't thrown, set new data in browser sync
    browser.storage.sync.set({"deviceInfo": json});
    importSplash.innerText = "Data imported! DuOSU will now login with this data.";
    clickLogin.disabled = false;
    // If click logins are enabled
    if(!json.reviewPush) {
      clickLogin.checked = true;
    } else {
      clickLogin.checked = false;
    }
    // Slide index needs to be assigned
    // Otherwise it assumes the program is first started
    updateSlide(0);
  } catch(e) {
    console.error(e);
    // Tell the user this is an invalid code
    importSplash.innerText = "Invalid data. Copy directly from export."
  }
});

// Export button
let exportText = document.getElementById("exportText");
document.getElementById("exportButton").addEventListener("click", async function() {
  let info = await new Promise(function(resolve) {
    browser.storage.sync.get('deviceInfo', function(json) {
      resolve(json.deviceInfo);
    });
  });
  // If the user tried to export when we have no data
  if(info == null) {
    exportText.value = "No data!";
  }
  else {
    // Set text to be data. Scramble with Base64 so the user doesn't try to tamper any of this
    exportText.value = window.btoa(JSON.stringify(info));
  }
});

// Reset button
let resetSplash = document.getElementById("resetSplash");
document.getElementById("resetButton").addEventListener("click", function() {
  // Delete browser local / sync data
  browser.storage.sync.clear(function() {
    browser.storage.local.clear(function() {
      document.documentElement.setAttribute("dark-theme", false);
      // Disable check box
      clickLogin.disabled = true;
      // Reset main page
      slideIndex = 0;
      errorSplash.innerText = "Use arrows to flip through instructions:";
      activateButton.innerText = "Activate";
      resetSplash.innerText = "Data cleared. Import data or reactivate."
    });
  });
});

// Returns a promise of the device info
async function getDeviceInfo() {
  return await new Promise(function(resolve) {
    browser.storage.sync.get('deviceInfo', function(json) {
      resolve(json == null ? null : json.deviceInfo);
    });
  });
}

// On startup
initialize();
// Changes the current screen to what it should be depending on if deviceInfo is present
async function initialize() {
  // Load active slide
  let object = await browser.storage.local.get('activeSlide');
  if(object.activeSlide != null) {
    slideIndex = object.activeSlide;
  }
  // Load theme
  let data = await new Promise(function(resolve) {
    browser.storage.local.get('theme', function(value) {
      resolve(value);
    });
  });

  // If button has been pressed before
  if(data != null) {
    let theme = data.theme;
    // Set it to the opposite of what we have
    document.documentElement.setAttribute("dark-theme", theme);
  }
  // If this is the first time opened
  if((await browser.storage.local.get('activeSlide')).activeSlide == null) {
    changeScreen("intro");
  } else {
    // On open, or when settings are changed, return the screen we should go to
    // If no data is found
    if(await getDeviceInfo() == null) {
      // Set HTML screen to activate
      changeScreen("activation");
    }
    else {
      // Set to main screen
      changeScreen("main");
    }
  }
}
