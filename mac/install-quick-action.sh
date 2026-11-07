#!/bin/bash
# Installs:  ~/bin/send-to-tv  (command line)  and  Finder → right-click → Quick Actions → "Send to TV".
# Usage: mac/install-quick-action.sh [TV_IP]
set -e
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/bin" "$HOME/.config"
cp "$here/send-to-tv.sh" "$HOME/bin/send-to-tv"; chmod +x "$HOME/bin/send-to-tv"
if [ -n "${1:-}" ]; then echo "TV_IP=$1" > "$HOME/.config/send-to-tv"; fi

wf="$HOME/Library/Services/Send to TV.workflow"
rm -rf "$wf"; mkdir -p "$wf/Contents"
cat > "$wf/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSServices</key><array><dict>
    <key>NSBackgroundColorName</key><string>background</string>
    <key>NSIconName</key><string>NSActionTemplate</string>
    <key>NSMenuItem</key><dict><key>default</key><string>Send to TV</string></dict>
    <key>NSMessage</key><string>runWorkflowAsService</string>
    <key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
    <key>NSSendFileTypes</key><array><string>public.item</string></array>
  </dict></array>
</dict></plist>
PLIST
cat > "$wf/Contents/document.wflow" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>AMApplicationBuild</key><string>523</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key><array><dict><key>action</key><dict>
    <key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
    <key>AMActionVersion</key><string>2.0.3</string>
    <key>AMApplication</key><array><string>Automator</string></array>
    <key>AMParameterProperties</key><dict>
      <key>COMMAND_STRING</key><dict/><key>CheckedForUserDefaultShell</key><dict/><key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/>
    </dict>
    <key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
    <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
    <key>ActionName</key><string>Run Shell Script</string>
    <key>ActionParameters</key><dict>
      <key>COMMAND_STRING</key><string>"\$HOME/bin/send-to-tv" "\$@" &gt; /dev/null 2&gt;&amp;1 &amp;</string>
      <key>CheckedForUserDefaultShell</key><true/>
      <key>inputMethod</key><integer>1</integer>
      <key>shell</key><string>/bin/bash</string>
      <key>source</key><string></string>
    </dict>
    <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
    <key>CFBundleVersion</key><string>2.0.3</string>
    <key>CanShowSelectedItemsWhenRun</key><false/>
    <key>CanShowWhenRun</key><true/>
    <key>Category</key><array><string>AMCategoryUtilities</string></array>
    <key>Class Name</key><string>RunShellScriptAction</string>
    <key>InputUUID</key><string>6A2C2D3E-1B2A-4C55-9E7A-2F0B7B1A1001</string>
    <key>Keywords</key><array><string>Shell</string><string>Script</string></array>
    <key>OutputUUID</key><string>6A2C2D3E-1B2A-4C55-9E7A-2F0B7B1A1002</string>
    <key>UUID</key><string>6A2C2D3E-1B2A-4C55-9E7A-2F0B7B1A1003</string>
    <key>UnlocalizedApplications</key><array><string>Automator</string></array>
    <key>arguments</key><dict/>
    <key>isViewVisible</key><integer>1</integer>
    <key>location</key><string>309.000000:253.000000</string>
    <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
  </dict><key>isViewVisible</key><integer>1</integer></dict></array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key><dict>
    <key>applicationBundleIDsByPath</key><dict/>
    <key>applicationPaths</key><array/>
    <key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>presentationMode</key><integer>15</integer>
    <key>processesInput</key><false/>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key><false/>
    <key>systemImageName</key><string>NSActionTemplate</string>
    <key>useAutomaticInputType</key><false/>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict></plist>
PLIST
plutil -lint "$wf/Contents/Info.plist" "$wf/Contents/document.wflow" >/dev/null
# Enable it in Finder's right-click menu (macOS keeps new services switched off)
defaults write pbs NSServicesStatus -dict-add '"(null) - Send to TV - runWorkflowAsService"' \
  '{ "enabled_context_menu" = 1; "enabled_services_menu" = 1; "presentation_modes" = { ContextMenu = 1; ServicesMenu = 1; TouchBar = 1; }; }'
/System/Library/CoreServices/pbs -update >/dev/null 2>&1 || true

# Droplet app: drag files onto it (Dock, Finder toolbar or sidebar). Works even when Quick Actions don't show up.
mkdir -p "$HOME/Applications"
osacompile -o "$HOME/Applications/Send to TV.app" "$here/SendToTV.applescript"
icon=/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/com.apple.appletv.icns
[ -f "$icon" ] && cp "$icon" "$HOME/Applications/Send to TV.app/Contents/Resources/applet.icns" && touch "$HOME/Applications/Send to TV.app"
echo "Installed: ~/bin/send-to-tv, Finder Quick Action \"Send to TV\", and ~/Applications/Send to TV.app (droplet)"
echo "Quick Action missing? Relaunch Finder, or open the workflow in Automator and press Cmd+S once. Or use the droplet: drag Send to TV.app into the Dock."
