import fs from 'fs';
import moment from 'moment';
import pkginfo from 'pkginfo';
import program from 'commander';
import * as webdriver from 'selenium-webdriver';
import * as chromeDriver from 'selenium-webdriver/chrome';

const info = pkginfo(module, 'version');

moment.locale('pt-br');

const defaultOutputFile = `./nubank-${moment().add(1, 'months').format('MM')}.ofx`;

program
    .version(info.version)
    .option('-u, --username <str>', 'Username')
    .option('-p, --password <str>', 'Password')
    .option('-c, --chrome-path <path>', 'Chrome binary path')
    .option('-t, --timeout <int>', 'Timeout, in seconds, while waiting for pages to load. Defaults to 10.')
    .option('-o, --output <path>', `Output file. Defaults to ${defaultOutputFile}`)
    .parse(process.argv);


const options = new chromeDriver.Options()
    .headless()
    .windowSize({width: 800, height: 600})
    .setChromeBinaryPath(program.chromePath);

const driver = new webdriver.Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();

const {By, until} = webdriver;
const waitTimeout = (program.timeout || 10) * 1000;

driver
    .then(() => console.log('Accessing...'))
    .then(() => driver.get('https://conta.nubank.com.br/'))
    .then(() => driver.findElement(By.id('username')).sendKeys(program.username))
    .then(() => driver.findElement(By.css('form input[type="password"]')).sendKeys(program.password))
    .then(() => driver.findElement(By.css('form button[type="submit"]')).click())
    .then(() => console.log('Logging in...'))
    .then(() => driver.wait(until.titleContains('Histórico'), waitTimeout))
    .then(() => driver.wait(until.elementLocated(By.css('div#loaderDiv')), waitTimeout))
    .then(loader => driver.wait(until.elementIsNotVisible(loader), waitTimeout))
    .then(() => console.log('Loading bills...'))
    .then(() => driver.findElement(By.css('li a.menu-item.bills')).click())
    .then(() => driver.wait(until.elementLocated(By.css('div#loaderDiv')), waitTimeout))
    .then(loader => driver.wait(until.elementIsNotVisible(loader), waitTimeout * 4))
    .then(() => console.log('Parsing charges...'))
    .then(() => driver.findElements(By.css('div.charges-list div.charge')))
    .then(charges => charges.map(parseCharge))
    .then(charges => Promise.all(charges))
    .then(charges => {
        console.log('Generating ofx...');
        return charges;
    })
    .then(charges => generateOfx(charges))
    .then(ofx => writeToFile(ofx, (program.path || defaultOutputFile)))
    .then(() => console.log('Done!'))
    .catch(err => console.log(err))
    .then(() => driver.quit());

function parseCharge(el) {
    const date = el.findElement(By.css('div.time')).getText();
    const desc = el.findElement(By.css('div.charge-data div.description')).getText();
    const amount = el.findElement(By.css('div.charge-data div.amount')).getText();
    return Promise.all([date, desc, amount])
        .then(([date, desc, amount]) => ({date, desc, amount}));
}

function writeToFile(s, path) {
    return new Promise((resolve, reject) => {
        fs.writeFile(path, s, err => {
            if (err) {
                reject(err);
            } else {
                resolve(err);
            }
        });
    });
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

<DTSERVER>20170703000000[-3:GMT]
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
<DTSTART>20161208000000[-3:GMT]
<DTEND>20170108000000[-3:GMT]

${charges.map(c => {
        const type = c.amount.indexOf('-') !== 0 ? 'DEBIT' : 'CREDIT';
        const amount = `${type === 'DEBIT' ? '-' : ''}${c.amount.replace(/^-/, '').replace(/,/g, '.')}`;
        return `
<STMTTRN>
<TRNTYPE>${type}
<DTPOSTED>${moment(c.date, 'DD MMM').year(moment().year()).format('YYYYMMDD')}000000[-3:GMT]
<TRNAMT>${amount}
<MEMO>${c.desc}
</STMTTRN>
`}).join('\n')}

</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}
