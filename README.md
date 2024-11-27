# lotus-bot v2.4.0

Bot for Multiple Social Networking Platforms for Giving/Receiving Lotus to/from other Users.

## Current Build Tests

_Continuous Testing & Integration not implemented yet_

## Requirements

- Ubuntu 24.04 or later
- NodeJS 18.x (Recommend NodeJS repository for latest security updates: https://nodejs.org/en/download/package-manager/) (For Windows Admins: Make sure NodeJS is installed to the system $PATH)
- TypeScript ^4.x (Installed during `npm install`) (For Windows Admins: Install this manually & globally - `npm install -g typescript`)
- Prisma ^4.8.x (Installed during `npm install`)
- PostgreSQL

## Automatic Installation - Linux

**Prerequisites**

Please install the following packages on your system for the automatic installer to work:

- git
- postgresql

To run the automated install, paste and execute the following command in your terminal: `curl https://github.com/LotusiaStewardship/lotus-bot/main/install.sh | sudo bash`

After the installation completes, you will need to edit your `/opt/lotusbot/.env` file to fill in the appropriate values for your platform!

The `install.sh` script will:

- Clone this repository to `/opt/lotusbot` directory
- Create a new system user with login disabled for the systemd service
- Create the `.env` config file
- Install NVM & NPM dependencies
- Set up Prisma and PostgreSQL database
- Install systemd service

## Runtime Notes

### Default Platform Commands

These commands are for the user-space; they are not administrative in nature.

```
balance .......... Check your Lotus balance
deposit .......... Deposit Lotus to your account
withdraw ......... Withdraw Lotus to your wallet address
link    .......... Connect platform accounts to share a wallet balance
give    .......... Give Lotus to another user
```

### On-Chain Giving

Starting with v2.1.0, the "give" interaction of lotus-bot is now done on-chain. The Give database table is now simply used for tracking gives rather than for calculating user balances. User balances are now calculated solely by the UTXOs of the user's `WalletKey`.

### Support / Questions

Telegram: `@maff1989`  
Discord: `maff1989#2504`
