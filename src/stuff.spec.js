import 'mocha';
import moment from 'moment';
import {expect} from 'chai';
import {createDateFilter} from './stuff';

describe('date filter', () => {
    it('should accept everything when given (forever, forever)', () => {
        const filter = createDateFilter('forever', 'forever');

        let r = filter('1900-01-01', 'whatever');

        void expect(r).to.be.true;

        r = filter('lalala', 'nononon');

        void expect(r).to.be.true;
    });

    it('should work for open bills (open, forever)', () => {
        const filter = createDateFilter('open', 'forever');

        let r = filter('1900-01-01', 'whatever');

        void expect(r).to.be.false;

        r = filter('lalala', 'nononon');

        void expect(r).to.be.false;

        r = filter('lalalala', 'open');

        void expect(r).to.be.true;
    });

    it('should work for open bills (forever, now)', () => {
        const filter = createDateFilter('forever', 'now');

        let r = filter('1900-01-01', 'whatever');
        void expect(r).to.be.true;

        const today = moment().format('YYYY-MM-DD');
        r = filter(today, 'open');
        void expect(r).to.be.true;

        const tomorrow = moment().add(1, 'days').format('YYYY-MM-DD');
        r = filter(tomorrow, 'open');
        void expect(r).to.be.false;
    });
});