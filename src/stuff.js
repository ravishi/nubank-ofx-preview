import moment from 'moment';
import chrono from 'chrono-node';

export function createDateFilter(since, until) {
    const lowerBoundary = makeLowerDateBoundary(since);
    const upperBoundary = makeUpperDateBoundary(until);
    return (dt, billState) => (
        lowerBoundary(dt, billState) && upperBoundary(dt, billState)
    );
}

function makeLowerDateBoundary(spec) {
    if (spec === 'forever') {
        return () => true;
    } else if (spec === 'open') {
        const today = parseDate('today');
        return (dt, billState) => moment(dt).isSameOrAfter(today) || billState === 'open';
    } else {
        const specDate = parseDate(spec);
        return (dt) => moment(dt).isSameOrAfter(specDate);
    }
}

function makeUpperDateBoundary(spec) {
    if (spec === 'forever') {
        return () => true;
    } else if (spec === 'open') {
        const today = parseDate('today');
        return (dt, billState) => moment(dt).isSameOrBefore(today) || billState === 'open';
    } else {
        const specDate = parseDate(spec);
        return (dt) => moment(dt).isBefore(specDate);
    }
}

function parseDate(text) {
    // FIXME We should not need to resort to this kind of hackery just to parse our dates. Please improve this.
    moment.suppressDeprecationWarnings = true;
    try {
        const mt = moment(text);
        if (mt.isValid()) {
            return mt;
        } else {
            const dt = chrono.parseDate(text);
            return moment(dt);
        }
    } finally {
        moment.suppressDeprecationWarnings = false;
    }
}
