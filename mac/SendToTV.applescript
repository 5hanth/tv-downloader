-- "Send to TV" droplet: drop files on this app (Dock, Finder toolbar or sidebar) to upload them to the TV.
on open theItems
	set args to ""
	repeat with f in theItems
		set args to args & " " & quoted form of POSIX path of f
	end repeat
	do shell script "\"$HOME/bin/send-to-tv\"" & args & " > /dev/null 2>&1 &"
end open

on run
	set picked to choose file with prompt "Choose files to send to the TV" with multiple selections allowed
	open picked
end run
