while ($true) {
    Write-Host "Starting server..."
    node server.js
    Write-Host "Server exited with code $LASTEXITCODE. Restarting in 1 second..."
    Start-Sleep -Seconds 1
}
