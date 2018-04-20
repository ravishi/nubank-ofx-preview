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
        return (dt, billState) => billState === 'open';
    } else {
        const specDate = parseDate(spec);
        return (dt) => moment(dt).isSameOrAfter(specDate);
    }
}

function makeUpperDateBoundary(spec) {
    if (spec === 'forever') {
        return () => true;
    } else if (spec === 'open') {
        return (dt, billState) => billState === 'open';
    } else {
        const specDate = parseDate(spec);
        return (dt) => moment(dt).isBefore(specDate);
    }
}

function parseDate(text) {
    try {
        return moment(text);
    } catch (e) {
        const dt = chrono.parseDate(text);
        return moment(dt);
    }
}
