// Utilities
export const XPI_DIVISOR = 1000000

// Default bot database properties
export const BOT = {
  USER: {
    userId: 'bot',
    accountId: 'bot',
    secret: null,
    mnemonic: null,
    hdPrivKey: null,
    hdPubKey: null,
  },
  MESSAGE: {
    ERR_DM_COMMAND: 'Please send me this command in a DM.',
    ERR_NOT_DM_COMMAND: 'This command does not work in a DM.',
    ERR_MUST_GIVE_TO_OTHER_USER: 'You cannot give Lotus to yourself. :)',
    ERR_GIVE_MUST_REPLY_TO_USER:
      'You must reply to another user to give Lotus.',
    ERR_GIVE_TO_CHANNEL_DISALLOWED: `You cannot give Lotus to a Telegram channel.`,
    ERR_AMOUNT_INVALID: 'Invalid amount specified.',
    ERR_GIVE_TO_BOT:
      'I appreciate the thought, but you cannot give me Lotus. :)',
    DONATION:
      `%s, you have donated %s XPI %s! 🪷\r\n\r\n` +
      `The community fund grows ever larger. Your generosity is greatly appreciated!\r\n\r\n` +
      `[View tx on the Explorer](%s)`,
    GIVE:
      `%s, you have given %s XPI to %s! 🪷\r\n\r\n` +
      `[View tx on the Explorer](%s)`,
    RECEIVE: `%s, you have received %s XPI from %s! 🪷`,
    BALANCE: 'Your balance is %s XPI',
    DEPOSIT:
      `Send Lotus here to fund your account: \`%s\`\r\n\r\n` +
      `[View address on the Explorer](%s)`,
    DEPOSIT_RECV:
      `I received your deposit of %s XPI. ` +
      `Your balance is now %s XPI.\r\n\r\n` +
      `[View tx on the Explorer](%s)`,
    DEPOSIT_CONF:
      `Your deposit of %s XPI has been confirmed! ` +
      `Your balance is now %s XPI\r\n\r\n` +
      `[View tx on the Explorer](%s)`,
    WITHDRAW_OK:
      `Your withdrawal of %s XPI was successful!\r\n\r\n` +
      `[View tx on the Explorer](%s)`,
    WITHDRAW_FAIL: `There was an error processing your withdrawal: %s`,
    LINK:
      `I will link two of your accounts together so that your Lotus ` +
      `balances are combined into one.\r\n\r\n` +
      `Your secret code is: \`%s\`\r\n\r\n` +
      `Using your other account, send me this secret code with the "link" ` +
      `command and I will link your accounts together.`,
    LINK_OK: `Your accounts have now been linked! `,
    LINK_FAIL: `There was an error linking your account: %s`,
    BACKUP:
      `Your seed phrase is: \`%s\`\r\n\r\n` +
      `WARNING: If you have linked platform accounts, then the balance in ` +
      `this wallet may not reflect your total account balance. If you send ` +
      `Lotus from this wallet, it WILL be reflected in your total account ` +
      `balance. If you send Lotus to this wallet, you will receive a deposit ` +
      `notification.`,
  },
}

// BIP44 Wallet parameters
export const WALLET = {
  PURPOSE: 44,
  COINTYPE: 10605,
}

// Default transaction parameters
export const TRANSACTION = {
  /** Default withdrawal fee, in satoshis */
  FEE: 100000,
  /** Default output dust limit */
  DUST_LIMIT: 546,
  /** Minimum output amount for any Give/Withdraw */
  MIN_OUTPUT_AMOUNT: 1000,
}
