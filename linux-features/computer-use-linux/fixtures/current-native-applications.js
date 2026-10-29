// Current signed anonymous native metadata factory and assignment/exposure.
class TestHandler{nativeApplications=(function(){if("darwin"===process.platform||"win32"===process.platform)return{getByBundleId:async id=>await cachedApp(id)??await (0,catalog.findById)(id),list:catalog.list,getIcon:async({appPath:file,size:size})=>"medium"===size?{iconSmall:null,iconMedium:await mediumIcon(file)}:{iconSmall:await smallIcon(file)}}})()}
function expose(){return{nativeApplications:this.fetchHandler.nativeApplications}}
