/* -*- Mode: Java; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:set ts=4 sw=4 sts=4 et: */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Initial Developer of the Original Code is
 * Mike de Boer, Ajax.org.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const {Cc, Ci, Cu, Cm} = require("chrome"),
      {EventEmitter}   = require("events"),
      XPCOMUtils       = Cu.import("resource://gre/modules/XPCOMUtils.jsm").XPCOMUtils,
      processes        = {};

const NS_PIPETRANSPORT_CONTRACTID = "@mozilla.org/ipc/pipe-transport;1";
const NS_IPCBUFFER_CONTRACTID = "@mozilla.org/ipc/ipc-buffer;1";

let GUID = 0;

function mixin(obj, mixin) {
    for (let key in mixin)
        obj[key.toLowerCase()] = mixin[key];
    return obj;
};

const ChildProcess = EventEmitter.compose({
    command: null,
    args   : null,
    options: null,
    stdout : null,
    stdin  : null,
    stderr : null,
    emit   : function() this._emit.apply(this, arguments),
    
    constructor: function ChildProcess(command, args, options) {
        this._guid = ++GUID;
        processes[this._guid] = this;
        
        this.stderrData = null;
        
        this.command = command;
        this.args = args || [];
        
        this.options = mixin({
            cwd: undefined,
            env: []/*,
            customFds: [-1, -1, -1],
            setsid: false*/
        }, options || {});
        
        // create & open pipeListener for stderr, no matter if needed or not
        this.stderr = new ReadablePipe();
        this.stderrData = Cc[NS_IPCBUFFER_CONTRACTID].createInstance(Ci.nsIIPCBuffer);
        this.stderrData.open(-1, true);
        
        if (typeof this.command == "string") {
            let localfile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
            try {
                localfile.initWithPath(this.command);
                this._commandFile = localfile.QueryInterface(Ci.nsIFile);
            }
            catch(ex) {
                this._commandFile = this.command;
            }
        }
        else {
            this._commandFile = this.command;
        }
        if (typeof this.options.cwd == "string") {
            let localfile= Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
            localfile.initWithPath(this.options.cwd);
            this.options._cwd = localfile.QueryInterface(Ci.nsIFile);
        }
        else if (typeof this.options.cwd == "object") {
            this.options._cwd = this.options.cwd;
        }
        else {
            this.options._cwd = null;
        }
        
        this._pipeTransport = Cc[NS_PIPETRANSPORT_CONTRACTID].createInstance(Ci.nsIPipeTransport);
        this._pipeTransport.initWithWorkDir(this._commandFile, this.options._cwd, 
            Ci.nsIPipeTransport.INHERIT_PROC_ATTRIBS);
        
        // add a listener for asynchronous processing of data
        this.stdout = new ReadablePipe();
        this.stdoutListener = new StdoutStreamListener(this);
        
        this.stdoutListener.observe(new OnFinishedListener(this), null);
        
        this._pipeTransport.openPipe(this.args, this.args.length,
            this.options.env, this.options.env.length,
            0, "", true, this.options.mergeStderr ? true : false,
            this.stderrData);
        
        this._pipeTransport.asyncRead(this.stdoutListener, null, 0, -1, 0);
        
        this.stdin = new WritablePipe(this._pipeTransport);
    },
    
    /**
     * Wait for the subprocess to complete. This method is blocking.
     */
    wait: function () {
        this._pipeTransport.join();
    },
    
    /**
     * Kill the subprocess
     */
    kill: function() {
        try {
            this._pipeTransport.kill();
        }
        catch(ex) {
            // do nothing
        }
    }
});

/**
* Create a pipe that writes data to the subprocess
*
* @param func  function definition that implements writing to the pipe
*              using "this.write(txt)".
*/
const WritablePipe = EventEmitter.compose({
    _pipeTransport: null,
    emit: function() this._emit.apply(this, arguments),
    
    constructor: function WritablePipe(pipe) {
        this._pipeTransport = pipe;
    },
    
    write: function(data) {
        this._pipeTransport.writeSync(data, data.length);
    },
    
    end: function() {
        this._pipeTransport.closeStdin();
    }
});

/**
 * Create a pipe that read data from the subprocess (stdout or stderr)
 */
const ReadablePipe = EventEmitter.compose({
    emit: function() this._emit.apply(this, arguments)
});

/**
 * Stream Listener object for handling callbacks from the subprocess' stdout
 */
function StdoutStreamListener(ps){
    this._ps = ps;
    this._reqObserver = null;
}

StdoutStreamListener.prototype = {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIRequestObserver, Ci.nsIStreamListener]),
    
    // nsIObserver
    observe: function(aReqObserver, aContext) {
        this._reqObserver = aReqObserver;
    },
    
    // nsIRequestObserver
    onStartRequest: function(aRequest, aContext) {
        if (this._reqObserver)
            this._reqObserver.onStartRequest(aRequest, aContext);
    },
    
    // nsIRequestObserver
    onStopRequest: function(aRequest, aContext, aStatusCode) {
        // call to stderr and onFinished from here to avoid mandatory use of
        // p.wait()
        if (this._reqObserver)
            this._reqObserver.onStopRequest(aRequest, aContext, aStatusCode);
        
        // unset assigned variables to avoid memory leak
        this._reqObserver = null;
        this._ps = null;
    },
    
    // nsIStreamListener
    onDataAvailable: function(aRequest, aContext, aInputStream, offset, count) {
        let sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
        sis.init(aInputStream);
        if ("readBytes" in sis) {
            // Gecko > 2.0b4, supports NULL characters
            this._ps.stdout.emit("data", sis.readBytes(count));
        }
        else {
            // Gecko <= 2.0b4
            this._ps.stdout.emit("data", sis.read(count));
        }
        
        // unset variable to avoid memory leak
        sis = null;
    }
};

/**
 * Listener for handling subprocess termination
 */
function OnFinishedListener(ps) {
    this._ps = ps;
}

OnFinishedListener.prototype = {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIRequestObserver]),
    
    // nsIRequestObserver
    onStartRequest: function(aRequest, aContext) {
        // do nothing
    },
    
    // nsIRequestObserver
    onStopRequest: function(aRequest, aContext, aStatusCode) {
        // call to stderr and onFinished from here to avoid mandatory use of
        // p.wait()
        let ps = this._ps;
        
        if (!ps.options.mergeStderr) {
            ps.stderr.emit("data", ps.stderrData.getData());
            ps.stderrData.shutdown();
        }
        
        ps.emit("exit", ps._pipeTransport.exitValue);

        // unset assigned variables to avoid memory leak
        delete processes[ps._guid];
        this._ps = null;
    }
};

/**
 * spawn a child process.
 * @param {string} command The command to execute
 * @param {array of strings, or string} args Argument(s) to said command. If not an array,
 *        will be assumed to be a single argument.
 * @param {object} options The third argument is used to specify additional options, 
 * which defaults to:
 * { cwd: undefined,
 *   env: []
 * }
 * `cwd` allows you to specify the working directory from which the process is 
 * spawned. Use `env` to specify environment variables that will be visible to the 
 * new process.
 * @returns A ChildProcess
 */
exports.spawn = function(command, args, options) {
    if (!Array.isArray(args)) {
        args = [args];
    }
    args.forEach(function(x) {
        if (typeof x != "string")
            throw "args (passed to child_process.spawn) must be all strings";
    });
    var child = new ChildProcess(command, args, options);
    return child;
};

exports.ChildProcess = ChildProcess;
/** @endclass */

require("unload").when(function unload() {
    for each(let process in processes)
        process.kill();
});
