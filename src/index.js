import fs from 'fs';
import sh from 'shorthash';
import path from 'path';
import moment from 'moment';
import pkginfo from 'pkginfo';
import program from 'commander';
import puppeteer from 'puppeteer';

const info = pkginfo(module, 'version');

program
    .version(info.version)
    .option('--include-id', 'Include an unique ID in each transaction description.')
    .option('-f, --format <str>', 'Format. Defaults to ofx. Can also be json.')
    .option('-u, --username <str>', 'Username. Required.')
    .option('-p, --password <str>', 'Password. Required.')
    .option('-t, --timeout <int>', 'Timeout, in seconds, while waiting for pages to load. Defaults to 30.')
    .option('-o, --output <path>', `Output file. Defaults to ${defaultOutputFile}`)
    .parse(process.argv);

if (!program.username || !program.password) {
    console.error('Please, provide a --username and a --password');
    process.exit(1);
}

const configuredFormat = (
    program.format && program.format.toLowerCase() === 'json'
        ? 'json'
        : 'ofx'
);

const defaultOutputFile = `./nubank-${moment().add(1, 'months').format('YYYY-MM')}.${configuredFormat}`;

const outputPath = (
    program.output
        ? path.join(process.cwd(), program.output)
        : defaultOutputFile
);

const configuredTimeout = (
    program.timeout
        ? program.timeout * 1000
        : 30000
);

const shouldIncludeUid = !!program.includeId;

puppeteer.launch({headless: true})
    .then(async browser => {
        try {
            return await fetchBillAndSaveFile(await browser.newPage());
        } finally {
            await browser.close();
        }
    })
    .then(() => console.log(`Done! ${configuredFormat.toUpperCase()} file saved to ${outputPath}.`));


const baseUrl = 'https://conta.nubank.com.br';

async function fetchBillAndSaveFile(page) {
    page.setDefaultNavigationTimeout(configuredTimeout);

    console.log('Logging in...');

    await login(page, program.username, program.password);

    console.log('Fetching bill...');

    const bill = await fetchLastBill(page);

    const timezoneOffset = await page.evaluate(() => new Date().getTimezoneOffset());
    const items = bill.line_items.map(i => toItem(timezoneOffset, i));

    console.log(`Generating ${configuredFormat.toUpperCase()}...`);

    const output = (
        configuredFormat === 'json'
            ? JSON.stringify(items, null, 2)
            : generateOfx(items)
    );

    return await writeToFile(output, outputPath);
}

async function login(page, username, password) {
    await page.goto(baseUrl, {waitUntil: 'networkidle0'});

    await page.waitForSelector('#username', {visible: true, timeout: configuredTimeout});
    await page.waitForSelector('form input[type="password"]', {visible: true, timeout: configuredTimeout});

    const usernameInput = await page.$('#username');
    await usernameInput.focus();
    await usernameInput.type(username, {delay: 100});

    const passwordInput = await page.$('form input[type="password"]');
    await passwordInput.focus();
    await passwordInput.type(password, {delay: 100});

    const submit = await page.$('form button[type="submit"]');

    // TODO: Create some kind of waitForNetworkIdle function and use it here.
    // See: - https://github.com/GoogleChrome/puppeteer/issues/1412
    //      - https://github.com/GoogleChrome/puppeteer/issues/1608
    //
    await submit.click();

    // XXX For now, we are clicking and waiting for a selector. But that's pretty volatile, if you ask me.
    const billsButtonSelector = 'li a.menu-item.bills';
    await page.waitForSelector(billsButtonSelector, {timeout: configuredTimeout});

    return true;
}

async function fetchLastBill(page) {
    // XXX We go to blank, then back to bills page in order to be able to wait for 'load'
    // TODO In the future, we should have a waitForNetworkIdle kind of function to be used here.
    await page.goto('about:blank', {waitUntil: 'load'});

    const [bill, _ignoredResult] = await Promise.all([
        waitForBillData(page),
        page.goto(`${baseUrl}/#/bills`, {waitUntil: 'load'}),
    ]);

    return bill;
}

function waitForBillData(page) {
    // TODO Maybe we could introduce a timeout here?
    // TODO Maybe we could turn this into a helper, which receives a
    // "filter/mapper" and either returns from that filter or times out
    // if the filter doesnt pass.
    return new Promise((resolve, reject) => {
        const onResponse = response => {
            response.json().catch(() => null).then(data => {
                if (data && data.bill && data.bill.state === 'open') {
                    resolve(data.bill);
                }
            });
        };

        const onError = error => {
            page.off('error', onError);
            page.off('response', onResponse);
            reject(error);
        };

        page.on('error', onError);
        page.on('response', onResponse);
    });
}

async function writeToFile(s, path) {
    return await new Promise((resolve, reject) => {
        fs.writeFile(path, s, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function toItem(timezoneOffset, {id, title, amount, post_date: date}) {
    const shortid = sh.unique(id);
    const memo = (
        !shouldIncludeUid ? title : `#${shortid} - ${title}`
    );
    return {
        id,
        date: {date, timezoneOffset},
        memo,
        title,
        amount: ((-1) * amount / 100).toFixed(2),
        shortid,
    };
}

function ofxItem({id, date: {date, timezoneOffset}, memo, amount}) {
    return `
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>${moment(date).format('YYYYMMDD')}000000[${timezoneOffset / 60 * -1}:GMT]
<TRNAMT>${((-1) * amount / 100).toFixed(2)}
<FITID>${id}</FITID>
<MEMO>${memo}</MEMO>
</STMTTRN>
`;
}

function generateOfx(charges) {
    return `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<LANGUAGE>POR
</SONRS>
</SIGNONMSGSRSV1>

<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>1001
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<CCSTMTRS>
<CURDEF>BRL
<CCACCTFROM>
<ACCTID>nubank-ofx-preview
</CCACCTFROM>

<BANKTRANLIST>
${charges.map(ofxItem).join('\n')}
</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}
