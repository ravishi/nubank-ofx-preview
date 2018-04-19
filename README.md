# nubank-ofx-preview

Generate a preview OFX from your [NuBank](https://nubank.com.br/) account.

## Wait, what?

[NuBank](https://nubank.com.br/) doesn't let you export your bills as OFX before they're closed.

But through the power of [automation](https://github.com/GoogleChrome/puppeteer), this program logs into their site, reads all transactions and generates a valid OFX file to be used in your favourite budgeting tool.


## Installation

```
npm install -g nubank-ofx-preview
```

## Usage

```
nubank-ofx-preview --username=<your-username> --password=<your-password>
```

## Documentation

```
nubank-ofx-preview --help
```

## Final words

Happy budgeting!
