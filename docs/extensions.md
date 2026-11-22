# Chrome extensions

Open an extension’s Chrome Web Store listing in Relay. Click **Add to Relay** in the browser toolbar above the page. Relay downloads the signed package from Google’s update service and asks you to approve the extension and its declared permissions. For an installed extension, the toolbar opens **Manage extensions**.

You can also open **Extensions** and enter a Chrome Web Store listing URL or its 32-letter extension ID.

For development or an extension distributed as source, choose **Load unpacked** and select the directory with a top-level manifest.json file. Relay loads that directory on each launch. Removing the extension leaves the original directory on disk.

Where an extension declares a popup or options page, use **Open** next to the extension. Relay displays the page in a browser tab. Some extensions rely on browser actions, background APIs, or permissions that Electron does not implement, so compatibility varies even when installation succeeds. See the [extension APIs supported by Electron](https://www.electronjs.org/docs/latest/api/extensions).

Relay checks that an extension’s background service worker can start before opening its page. If startup fails, the Extensions panel shows **Couldn’t start** and offers **Try again**. LastPass currently installs from the Store, and its toolbar depends on Chrome APIs that are unavailable in Relay.

Relay checks Store packages against the requested extension ID and both the developer signature and production publisher key before extracting them. To get a newer Store version, remove the extension and install it again. [Chrome Web Store publisher key](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx_verifier.cc)
