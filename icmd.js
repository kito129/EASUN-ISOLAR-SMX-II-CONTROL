import net from 'net'
import fs from 'fs'
import dgram from 'dgram'
import localIpV4Address from 'local-ipv4-address'
import {exit} from 'process';
import { Buffer } from 'buffer'

import Logger from './logger.js' // Import the Logger class

const buffer = Buffer.alloc(4)
const logger = new Logger()

function runScript(args) {

    let commands={}
    let cdata=fs.readFileSync('commands-simple.json',{encoding:'utf8', flag:'r'})

    try{ 
        commands=JSON.parse(cdata)
    }catch(e){
        logger.log(e)
    }

    logger.log("!!! 0. Please connect to the data-logger wifi access point or ensure the device is accessible on your network !!!")
    logger.log("!!! On initial setup the data-logger ip address is the gateway (obtained by dhcp from the data-logger wifi AP) !!!")
    logger.log("!!! Provide custom local ip if the machine that you are running this script from is available on a custom route not on the default one (vpn setup) !!!")

    logger.log("Quick examples:\n Query all inverter parameters: npm start get-smx-param [data-logger ip address]")
    logger.log(" Set output priority(parameter 1) to SOL: npm start set-smx-param [data-logger ip address] 1 SOL ")

    let customIp=""
    let original_argv=args.slice()
    
    args.forEach(function(el, index, object){
        //logger.log(el)
        let m=el.match(/^localip=((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/)
        if (m) {
            //if localIp is provided before command -> error
            if (index===2) {
                logger.log('Argument error: No COMMAND provided!')
                logger.log("\nUSAGE: COMMAND [options] [localip=192.168.89.255]\n\nCOMMANDS:")
                commands.commandsequences.forEach(function(cs){
                    logger.log(cs.name+" "+cs.args+" \n ("+cs.desc+")\n")
                })
                exit(-1)
            }
            customIp=el.substring(8)
            logger.log("")
            object.splice(index,1)
        }
    })
    
    let myArgs = args.slice(2)

    logger.log("\nUSAGE: COMMAND [options] [localip=192.168.89.255]\n\nCOMMANDS:")
    commands.commandsequences.forEach(function(cs){
        logger.log(cs.name+" "+cs.args+" \n ("+cs.desc+")\n")
    })

    logger.log("\n")

    let global_commandsequence="" //run more commands after another
    let globalCommandParam="" //run more parameters for 1 command
    let groupedCommandParam="" //run 1 query for multiple parameters
    let global_tcp_seq=1 //sends the device in every command: modbus transaction id

    let argscount=[]

    if (myArgs.length==0){
        logger.log("\n No command supplied! ")
    }else{

        commands.commandsequences.forEach(function(cs){
            
            if (cs.name===myArgs[0]){
                
                global_commandsequence=myArgs[0]
                logger.log("Running: "+global_commandsequence)

                argscount=[]
                cs.seq.forEach(function(cd){
                    let nc=commands.commands.find(cdf => cdf.name === cd)
                    
                    let reg=nc.cmd.match(/\{ARG[PV]*[0-9]+\}/g)
                    if (reg!=null && reg!==false && reg!==undefined ) argscount=argscount.concat(reg)

                    //logger.log(nc)
                    if (nc.hasOwnProperty('definition') && Array.isArray(nc.definition)) {
                        //exit(0)
                        
                        //optional last argumentum (start param to query)
                        let lastArg=myArgs[myArgs.length-1]
                        let ind=nc.definition.findIndex(o => o.num === lastArg )

                        globalCommandParam=(lastArg.match(/^[0-9]+$/) && ind>0 ?ind:0)

                        logger.log("Starting from param: ",globalCommandParam)

                        //check addresses to join to query together
                        let addrord=[]
                        nc.definition.forEach(function(el,ind){
                            
                            if (ind>=globalCommandParam){

                                let addr=parseInt(el.address, 16)
                                
                                addrord.push({'index': ind,'address':addr, 'name': el.name,'type': (Number.isInteger(el.type)?el.type:1)})
                                
                            }
                        })

                        addrord.sort(function(a,b){ return a.address-b.address })

                        let bymem=[]
                        let lv=0

                        addrord.forEach(function(el, ind){
                            if (bymem.length===0){
                                bymem.push([el])
                            }else{

                                if (bymem[lv][0].address+123>(el.address+(Number.isInteger(el.type)?el.type:1))){
                                    bymem[lv].push(el)
                                }else{
                                    bymem.push([el])
                                    lv++
                                }

                            }
                        })
                        

                        //logger.log("sortedaddrs:", bymem)
                        
                    }
                    
                })
            
                let arguniq=argscount.filter((v, i, a) => a.indexOf(v) === i)
                
                if (myArgs.length<arguniq.length+2) {
                    logger.log("Wrong number of arguments! Exiting...")
                    exit(-1)
                }

                //default 4 min timeout to prevent stucking node if not error event occurs in tcp communication but no answer received
                setTimeout(function() {
                    logger.log("Timeout occurred...exiting!")
                    exit(-1)
                }, (1000*60*4))

                sendudp(myArgs[1])

            }

        })

    }


    function sendudp(devip){

        try{

            localIpV4Address().then(function(ip){
            
                if (customIp!==""){
                    ip=customIp
                }
                
                logger.log("Using local ip to create TCP server: "+(ip))

                startTcp()

                let client = dgram.createSocket('udp4')
                let port=58899
                let command="set>server="+ip+":8899"
                
                logger.log("Sending UDP packet(port: "+port+") to inform data-logger device to connect the TCP server:")
                logger.log(command)

                client.on('listening', function () {
                    let address = client.address()
                    logger.log('UDP server listening on ' + address.address + ":" + address.port)
                })

                client.on('error', (err) => {
                    logger.log(`UDP server error:\n${err.stack}`)
                    client.close()
                })

                client.on('message',function(message, remote){
                    logger.log(remote.address + ':' + remote.port +' - ' + message)
                    logger.log("Got answer, closing UDP socket...")
                    client.close()
                })

                client.send(command,0, command.length, port, devip)

            })

        }catch(e){
            logger.log("Error: ",e)
            exit(-1)
        }
        
    }

    function startTcp(){

        let port=8899
        let command_seq=0

        logger.log("starting TCP server(port: "+port+") to receive data....")

        let server = net.createServer(function(socket) {

            logger.log(`${socket.remoteAddress}:${socket.remotePort} connected on TCP`)
            
            let outSum="\n"
            let outObj={}
            let startPos = 0
            let lenValue = 0

            //socket.pipe(socket)
            socket.on('data',function(data){
                //logger.log("Got TCP packet...")
                //dumpdata(data)
                //logger.log("Binary: ",data.toString())
                //logger.log("\n")

                let lastCmdName=getCommSeqCmd(command_seq-1)
                //logger.log(lastcmdname)
                let lastCmdDef = commands.commands.find(e => e.name === lastCmdName)
                //logger.log(lastcmddef)
                if (globalCommandParam!=="" && lastCmdDef!==undefined && lastCmdDef!==null && lastCmdDef.hasOwnProperty('definition')){

                    let handled=[]
                    lastCmdDef.definition.forEach(function(def,ind){

                        if (globalCommandParam!=="") {
                            if (ind!==globalCommandParam) {
                                return
                            }
                        } else {

                            return
                        }

                        //modbus rtu response: fixed position to extract data from
                        let val=""
                        val=data.toString('hex')

                        process.stdout.write("Response orig:\n")
                        dumpData(data)

                        //data starts at byte 11
                        startPos=11

                        //1 byte len
                        startPos=data[10]

                        let tmpBuffer=data.slice(8,data.length-2)
                        let rcrc=data.slice(data.length-2,data.length)
                        //dumpdata(rcrc)
                        rcrc=rcrc.readUInt16BE().toString(16).padStart(4,'0')
                        //dumpdata(tmpbuf)
                        let chcrc=crc16modbus(tmpBuffer)
                        chcrc=chcrc.toString(16).padStart(4,'0')

                        let hcrc=chcrc.substring(2)+chcrc.substring(0,2)

                        logger.log("(Response info len: "+lenValue+" Data type: "+def.type+" "+"CRC check: "+hcrc+" "+rcrc+")")

                        if (hcrc!==rcrc){

                            let outt=(def.hasOwnProperty('num')?def.num.padStart(2,'0')+" ":"")+def.name+":\t \t NA : ERROR IN RESPONSE!"
                            logger.log(outt)

                            outObj[def.name]="N/A"
                            outSum+=outt+"\n"

                        }else{

                            //custom formats
                            if ( Number.isInteger(def.type) ){

                                //type with custom length: not needed -> string default
                                //val=val.substring(startpos*2,startpos*2+(lenval*2))

                                for(let c=0;c<lenValue*2;c++){
                                    handled[startPos*2+c]=1;
                                }

                                //default handle as string
                                let nb=data.slice(startPos,startPos+lenValue)
                                nb=nb.toString('utf8').replace(/\0/g, '')

                                if (def.hasOwnProperty('format')){
                                    //datetime
                                    if (def.format===100){
                                        nb= "20"+data.readUInt8(startPos+lenValue-6).toString()+"-"+
                                            data.readUInt8(startPos+lenValue-5).toString()+"-"+
                                            data.readUInt8(startPos+lenValue-4).toString()+" "+
                                            data.readUInt8(startPos+lenValue-3).toString().padStart(2,'0')+":"+
                                            data.readUInt8(startPos+lenValue-2).toString().padStart(2,'0')+":"+
                                            data.readUInt8(startPos+lenValue-1).toString().padStart(2,'0')
                                    }
                                    //fault codes
                                    if (def.format===101){
                                        nb = "FAULT0: "+data.readUInt16BE(startPos)+": "+def.unit[data.readUInt16BE(startPos)]+" "+
                                            "FAULT1: "+data.readUInt16BE(startPos+2)+": "+def.unit[data.readUInt16BE(startPos+2)]+" "+
                                            "FAULT2: "+data.readUInt16BE(startPos+4)+": "+def.unit[data.readUInt16BE(startPos+4)]+" "+
                                            "FAULT3: "+data.readUInt16BE(startPos+6)+": "+def.unit[data.readUInt16BE(startPos+6)]+" "

                                    }
                                }

                                val=nb

                            }else{

                                //basic types supported by Buffer class: most seem to be 2 bytes long
                                val=data['read'+def.type](startPos)

                                //hack: mark always 2 bytes: just for debugging
                                handled[startPos*2]=1
                                handled[startPos*2+1]=1
                                handled[startPos*2+2]=1
                                handled[startPos*2+3]=1

                                if (def.hasOwnProperty('rate')){
                                    val=val*def.rate
                                }

                                if (def.hasOwnProperty('format')){
                                    val=val.toFixed(def.format)
                                }

                            }

                            let stmp=(def.hasOwnProperty('num')?def.num.padStart(2,'0')+" ":"")+def.name+":\t \t "+val+" "+(Array.isArray(def.unit)?( def.unit[parseInt(val)]!==undefined? (" => "+def.unit[parseInt(val)]): '' ):def.unit)
                            logger.log(stmp)
                            outObj[def.name]=parseFloat(val)
                            if (Array.isArray(def.unit) && def.unit[parseInt(val)]!==undefined ) {
                                outObj[def.name+"_text"]=def.unit[parseInt(val)]
                            }
                            outSum+=stmp+"\n"

                        }

                        process.stdout.write("Response:\n")
                        dumpData(data,handled)

                    })

                    if (globalCommandParam!=="" && lastCmdDef.definition.length>globalCommandParam+1){
                        globalCommandParam++
                        //run again with another param
                        command_seq--
                    }
                }else{
                    process.stdout.write("Response:\n")

                    dumpData(data)

                    logger.log("String format:\n",data.toString())
                }

                let cmdstr=getCommSeqCmd(command_seq)
                
                if (cmdstr === undefined) { 
                    logger.log(outSum)
                    
                    if (Object.keys(outObj).length === 0 && outObj.constructor === Object) {
                        logger.log("JSON output:\n",outObj)
                        try {
                            fs.writeFileSync('currentdata.json',JSON.stringify(outObj))
                        } catch (err) {
                            console.error(err)
                        }
                    }    

                    // logger.saveToFile(generateFileName())
                    logger.log("DONE, exiting")
                
                    exit(0)
                }
                
                socket.write(getdatacmd(cmdstr))
                command_seq++
                
            })

            socket.on('error',function(error){
                console.error(`${socket.remoteAddress}:${socket.remotePort} Connection Error ${error}..., exiting...`)
                exit(-1)
            })

            socket.on('close',function(){

                //this happens usually when the inverter drops the serial line
                //to force the datalogger to reconnect we need to restart it

                /*
                process.on("exit", function () {
                    logger.log("process.onexit")
                    //hardcoded restart command
                    process.argv[2]="restart-wifi"
                    require("child_process").spawn(process.argv.shift(),process.argv, {
                        cwd: process.cwd(),
                        detached : true,
                        stdio: "inherit"
                    })
                })
                */

                logger.log(`${socket.remoteAddress}:${socket.remotePort} Connection closed, exiting and trying to restart datalogger adapter...`)
                logger.log("\n")

                //close tcp server
                server.close()

                original_argv[2]="restart-wifi"
                runScript(original_argv)
                
            })

            let commandString=getCommSeqCmd(command_seq)
            if (commandString === undefined) { logger.log("Missing command sequence, exiting...")
                exit(-1) }


            
            let tw=getdatacmd(commandString)
            //logger.log("write:",tw)
            socket.write(tw)
            command_seq++

        })

        server.listen(port, '0.0.0.0')

    }


    //get next command for the commany sequence by index
    function getCommSeqCmd(index){

        let obj=commands.commandsequences.find(o => o.name === global_commandsequence )
        return obj.seq[index]
    }

    function getdatacmd(data){

        logger.log("\nCommand: "+data)

        let obj=commands.commands.find(o => o.name === data )
        //definition array link following
        if (typeof obj.definition === 'string'){
            obj.definition=commands.commands.find(o => o.name === obj.definition ).definition
        }

        let cmdtorun=obj.cmd
        //place simple input args in modbus commands
        let i=0
        myArgs.forEach(function(el){

            let hext=Buffer.from(el, 'utf8').toString('hex')
            if (obj.hasOwnProperty('raw') && obj.raw===true){
                hext=el
            }
            cmdtorun=obj.cmd.replace('{ARG'+i+'}',hext)
            i++
        })

        //custom built modbus command
        cmdtorun=handleModbusCommand(cmdtorun,obj)

        //compute and place length where needed
        let matches=cmdtorun.match(/\{LEN\}(.+)$/)
        if (matches) {
            cmdtorun=cmdtorun.replace("{LEN}",(matches[1].length/2).toString(16).padStart(4, '0'))
        }

        //add modbus tcp transaction id, just an incemental index
        cmdtorun=cmdtorun.replace('{SEQ}',String(global_tcp_seq).padStart(4, '0'))
        global_tcp_seq++

        process.stdout.write("Request: ")
        dumpData(cmdtorun)
        

        return Buffer.from(cmdtorun, 'hex')
    }

    function getparam(cmd,ind){

        let param=cmd.definition.find(o => o.num === ind )
        if (param!==undefined) {
            logger.log("Requested param: "+param.name)
            return param
        }
        return ""
    }

    //hex dump with color highlighted terminal output
    function dumpData(data,handled=null){

        let stringData=data.toString('hex')
        
        let out=""
        let i=1
        let bgred=""
        let normal=""
        let exp = [...stringData]
        exp.forEach(element => {
            
            bgred="\x1b[42m"
            normal="\x1b[0m"

            if (Array.isArray(handled)){
                if (handled[i-1]==1) {
                    out+=bgred
                }    
            }
            out+=element
            if (Array.isArray(handled)){
                if (handled[i-1]===1) {
                    out+=normal
                }
            }    

            if (i%2===0) {
                out+=" "
            }

            if (i%16===0) {
                out+="  "
            }

            if (i%32===0) {
                out+="\n"
            }

            i++

        })

        logger.log(out)

    }

    function handleModbusCommand(command,cmd) {

        if (!command.match(/{CRC}/)) return command
    
        let addr = ""
        let type = ""

        if (globalCommandParam!==""){
            
            addr = cmd.definition[globalCommandParam].address
            type = cmd.definition[globalCommandParam].type
            logger.log("Querying param: "+cmd.definition[globalCommandParam].name+"\n")
            if (groupedCommandParam==="") {
                groupedCommandParam=0
            }
        }
        
        //join queries
        
        //let nrlen=bymem[grouped_commandparam].length+bymem[grouped_commandparam][bymem[grouped_commandparam].length-1]['type']
        //listval.toString(16).padStart(4,'0')

        let reqLength='0001' //modbus defines 16bytes, some complex data are stored on multiple registers
        if (Number.isInteger(type)){
            reqLength=type.toString(16).padStart(4,'0')
        }
            
        command=command.replace('{PARAM}',addr+reqLength)

        
        //HANDLE set command...    
        let setParam=""
        let setParaMind=0
        let setVal=""
        let setValInd=0

        //get args and connected data
        let i=0
        myArgs.forEach(function(el) {

            if ( command.indexOf('{ARGP'+i+'}')!==-1) {
                setParaMind=i
                setParam=cmd.definition.find(o => o.num === el )
            }

            if ( command.indexOf('{ARGV'+i+'}')!==-1) {
                setValInd=i
                setVal=el
            }

            i++
        })

        //logger.log(setparam)
        //logger.log(setval)

        if (setParam!=="" && setVal!=="") {

            if ( command.indexOf('{ARGP'+setParaMind+'}')!==-1) {

                //default 1 register            
                let regLength="0001"
                if (Number.isInteger(setParam.type)) {
                    regLength=setParam.type.toString(16).padStart(4,'0')
                    logger.log("Error: Not supported type:", setParam.type)
                    exit(-1)
                }    

                let specargParam=setParam.address+regLength
                command=command.replace('{ARGP'+setParaMind+'}',specargParam)
                
            }

            if ( command.indexOf('{ARGV'+setValInd+'}')!==-1) {
                //default 2 bytes
                let defLength='02'
                let rv='0000'

                if (Array.isArray(setParam.unit)) {
                    let listValue=setParam.unit.indexOf(setVal)
                    if (listValue===-1){
                        logger.log("Error: The requested value is not valid, values:", setParam.unit)
                        exit(-1)
                    }
                    if (Number.isInteger(listValue)){
                        
                        rv=listValue.toString(16).padStart(4,'0')
                    }else{
                        logger.log("Error: The requested value is not compatible with the parameter type ("+setParam.type+")!")
                        exit(-1)
                    }
                    
                }else{

                    switch (setParam.type) {
                        case "UInt16BE":
                        case "Int16BE":
                            if (setVal.match(/^[0-9\.]+$/) ){
                                if (parseInt(setVal).toString() === setVal){
                                    setVal=parseInt(setVal)
                                }
                            }else{
                                logger.log(setParam)
                                logger.log("Error: The requested value ("+setVal+") is not compatible with the parameter type!")
                                exit(-1)
                            }
                            
                            setVal=Math.round(setVal/setParam.rate)
                            rv=setVal.toString(16).padStart(4,'0')

                        break
                        default:
                            logger.log(setParam)
                            logger.log("Error: The requested parameter is not writable now!")
                            exit(-1)
                    }
                }

                //logger.log(rv)
                
                let specArgValue=defLength+rv
                //logger.log("replace:",specArgValue)
                
                command=command.replace('{ARGV'+setValInd+'}',specArgValue)
                
            }
            
        }
        
        let matches=command.match(/\{LEN\}[a-f0-9A-F]{4}(.+)\{CRC\}$/)
        let inner=""
        if (matches) {
            //{CRC} -> 5 char vs 4char hex(2 byte): -1
            inner=Buffer.from(matches[1],'hex')
        }

        let crc=crc16modbus(inner)
        
        crc=crc.toString(16).padStart(4,'0')
        
        command=command.replace("{CRC}",crc.substring(2)+crc.substring(0,2))

        if (setParam!=="" && setVal!=="") {
            logger.log("Constructed modbus RTU command:"+command)
            //logger.log("Dry run exiting here....")
            //exit(0)
        }    
            
        return command

    }

    function crc16modbus(data){
        
        const table = [
            0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
            0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400
        ]
        
        let crc = 0xFFFF

        for (let i = 0; i < data.length; i++) {
            let ch = data[i]
            crc = table[(ch ^ crc) & 15] ^ (crc >> 4)
            crc = table[((ch >> 4) ^ crc) & 15] ^ (crc >> 4)
        }

        return crc
        
    }

}

function generateFileName() {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0') // Add 1 to month because months are zero-indexed
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}_log.txt`
}

runScript(process.argv)


