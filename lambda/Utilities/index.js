'use strict';

module.exports = {
    ...require('./logger'),
    ...require('./solax-client'),
    ...require('./tariff')
};
