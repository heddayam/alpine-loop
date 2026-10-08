# Alpine Loop

TaaS

## Install and start

1. Install and open [OrbStack](https://docs.orbstack.dev/install) (recommended for Mac) or [Docker Desktop](https://docs.docker.com/get-started/get-docker/) (Mac, Windows or Linux).
2. [Download the ZIP](https://github.com/heddayam/alpine-loop/archive/refs/heads/main.zip), unzip it, and open a terminal in the extracted folder. Or, if you have Git installed:

   ```sh
   git clone https://github.com/heddayam/alpine-loop.git
   cd alpine-loop
   ```

3. Run:

   ```sh
   docker compose up --build -d --wait
   ```

4. Open [Alpine Loop](http://127.0.0.1:3000) in your browser.

## Find a hike

Choose regions, set your distance and elevation limits, then click **Download and search**.
Only your selected regions download. Follow progress in **Jobs**, then open the completed search to view hikes.

Downloaded regions and saved searches stay on your computer.
Stop the app with `docker compose down`; run the startup command again to reopen it.

[App details and development](docs/app-reference.md)
