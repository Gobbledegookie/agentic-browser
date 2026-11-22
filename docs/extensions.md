# Chrome extensions

Open an extension’s Chrome Web Store listing in Relay. Click **Add to Relay** in the browser toolbar above the page. Relay downloads the signed package from Google’s update service and asks you to approve the extension and its declared permissions. For an installed extension, the toolbar opens **Manage extensions**.

You can also open **Extensions** and enter a Chrome Web Store listing URL or its 32-letter extension ID.

For development or an extension distributed as source, choose **Load unpacked** and select the directory with a top-level manifest.json file. Relay loads that directory on each launch. Removing the extension leaves the original directory on disk.

Install LastPass from the Chrome Web Store and click **Open LastPass** in the navigation toolbar to sign in. The LastPass popup stays attached to the browser window so the website you want to fill remains the active tab. You can also open it from **Extensions**.

If you already installed LastPass in an earlier Relay version, open Relay with an internet connection the first time so it can verify your installation with the Chrome Web Store. Relay keeps LastPass’s existing extension storage.

For other extensions that declare a popup or options page, choose **Open extension** from **Extensions**. Relay checks that the background worker can start before opening the page. When startup fails, Relay displays **Couldn’t start** with a **Try again** button. Compatibility varies by extension. [Electron’s supported extension APIs](https://www.electronjs.org/docs/latest/api/extensions)

Relay checks Store packages against the requested extension ID and both the developer signature and production publisher key before extracting them. To get a newer Store version, remove the extension and install it again. [Chrome Web Store publisher key](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx_verifier.cc)
