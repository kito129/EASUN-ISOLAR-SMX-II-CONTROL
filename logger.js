import fs from 'fs'

export default class Logger {
    constructor() {
        this.logMessages = []
    }

    log(message) {
        console.log(message)
        this.logMessages.push(message)
    }

    saveToFile(fileName) {
        console.log("Saving log to file: ", fileName)
        const logString = this.logMessages.join('\n')
        fs.writeFile(fileName, logString, (err) => {
            if (err) {
                console.error('Error writing to log file:', err)
            } else {
                console.log('\n\n\n *** Log data has been saved to', fileName, " *** \n\n\n")
            }
        })
    }
}
